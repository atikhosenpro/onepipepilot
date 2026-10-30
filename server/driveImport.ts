/** Imports one Google Drive file into the existing media pipeline: Drive API -> streamed temp file -> validate -> shared ingest (storage + DB + metadata + public URL). */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Ctx, ImportJob } from './context';
import { AppError } from './errors';
import { DRIVE_FOLDER, DRIVE_SHORTCUT, DriveError, WORKSPACE_EXPORTS, driveFetch, getFileMeta, mapDriveHttpError, mediaUrl, type DriveFile } from './driveClient';
import { DriveUrlError, parseDriveSource } from './driveUrl';
import { ingestMedia } from './ingest';
import { IMAGE_EXTRA_EXTS, IMAGE_MIME, VIDEO_EXTS, safeExtension, type MediaType } from './mediaTypes';
import { diskSpace } from './storage';
import { toItem, type VideoRow } from './videos';

export type Library = 'auto' | MediaType;
export interface ImportRequest { source: string; library: Library; keyId: string | null; actor: string | null; ip: string | null; origin: 'api' | 'dashboard' }
export interface ImportResult { row: VideoRow; duplicate: boolean }

const IDLE_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT = 2;

/** Which library a Drive file belongs to, judged from Google's metadata (content is validated again after download). */
export function libraryFor(meta: Pick<DriveFile, 'mimeType' | 'name'>): MediaType {
  const ext = safeExtension(meta.name);
  if (meta.mimeType.startsWith('video/') || (meta.mimeType === 'application/octet-stream' && VIDEO_EXTS.includes(ext))) return 'video';
  if (meta.mimeType.startsWith('image/') || (meta.mimeType === 'application/octet-stream' && (IMAGE_MIME[ext] || IMAGE_EXTRA_EXTS.includes(ext)))) return 'image';
  if (VIDEO_EXTS.includes(ext) && ext !== 'ts' && !meta.mimeType.startsWith('audio/')) return 'video';
  return 'file';
}

// ---------- job registry (progress for the dashboard and the API) ----------
export function newJob(ctx: Ctx, origin: ImportJob['origin']): ImportJob {
  const job: ImportJob = { id: randomUUID(), origin, state: 'queued', fileId: null, name: null, library: null, bytes: 0, total: null, startedAt: new Date().toISOString(), finishedAt: null, duplicate: false, error: null, itemId: null, publicUrl: null };
  ctx.drive.jobs.set(job.id, job);
  while (ctx.drive.jobs.size > 50) ctx.drive.jobs.delete(ctx.drive.jobs.keys().next().value as string);
  return job;
}

async function acquire(ctx: Ctx): Promise<() => void> {
  if (ctx.drive.active >= MAX_CONCURRENT) await new Promise<void>((r) => ctx.drive.waiters.push(r));
  ctx.drive.active++;
  return () => { ctx.drive.active--; ctx.drive.waiters.shift()?.(); };
}

/** Runs an import and records its progress in `job`. Concurrent requests for the same Drive file share one download. */
export async function runImport(ctx: Ctx, req: ImportRequest, job: ImportJob): Promise<ImportResult> {
  let fileId: string;
  try { ({ fileId } = parseDriveSource(req.source)); }
  catch (e) {
    const err = e instanceof DriveUrlError ? new AppError(400, e.code === 'folder' ? 'drive_folder_not_supported' : e.code === 'unsupported' ? 'drive_unsupported_type' : 'invalid_drive_url', e.message) : (e as Error);
    return fail(ctx, job, req, err);
  }
  job.fileId = fileId;
  const flightKey = `${fileId}:${req.library}`;
  const existing = ctx.drive.inflight.get(flightKey) as Promise<ImportResult> | undefined;
  if (existing) {
    try { const r = await existing; job.state = 'done'; job.duplicate = true; fillDone(ctx, job, r.row); return { row: r.row, duplicate: true }; }
    catch (e) { return fail(ctx, job, req, e as Error); }
  }
  const p = doImport(ctx, req, job, fileId);
  ctx.drive.inflight.set(flightKey, p);
  try { return await p; } finally { ctx.drive.inflight.delete(flightKey); }
}

function fillDone(ctx: Ctx, job: ImportJob, row: VideoRow) {
  job.finishedAt = new Date().toISOString(); job.itemId = row.id; job.name = row.original_name; job.library = row.media_type; job.bytes = row.size; job.total = row.size;
  job.publicUrl = toItem(row, ctx.settings()).publicUrl as string | null;
}

function fail(ctx: Ctx, job: ImportJob, req: ImportRequest, e: Error): never {
  const err = e instanceof AppError ? e : new AppError(500, 'internal_error', 'The import failed unexpectedly.');
  job.state = 'failed'; job.finishedAt = new Date().toISOString(); job.error = { code: err.code, message: err.message };
  ctx.audit('drive_import_failed', { actor: req.actor, ip: req.ip, metadata: { code: err.code, fileId: job.fileId, origin: req.origin } });
  if (!(e instanceof AppError)) ctx.log.error('Drive import crashed', { error: e.message });
  throw err;
}

async function doImport(ctx: Ctx, req: ImportRequest, job: ImportJob, fileId: string): Promise<ImportResult> {
  const settings = ctx.settings();
  let release: (() => void) | null = null;
  let tempPath: string | null = null;
  try {
    job.state = 'running';
    ctx.audit('drive_import_requested', { actor: req.actor, ip: req.ip, metadata: { fileId, library: req.library, origin: req.origin } });

    // 1. metadata (also proves the connected account can see the file)
    let meta = await getFileMeta(ctx, fileId);
    if (meta.mimeType === DRIVE_SHORTCUT && meta.shortcutDetails) meta = await getFileMeta(ctx, meta.shortcutDetails.targetId);
    if (meta.trashed) throw new DriveError(404, 'drive_file_not_found', 'That file is in the Google Drive trash.');
    if (meta.mimeType === DRIVE_FOLDER) throw new AppError(400, 'drive_folder_not_supported', 'That is a folder. Link to a single file instead.');
    const exp = WORKSPACE_EXPORTS[meta.mimeType];
    if (meta.mimeType.startsWith('application/vnd.google-apps.') && !exp) throw new AppError(415, 'drive_unsupported_type', `Google ${meta.mimeType.split('.').pop()} items cannot be downloaded as a file.`);
    if (meta.capabilities?.canDownload === false) throw new DriveError(403, 'drive_download_restricted', 'The owner has disabled downloading for this file.');
    job.name = meta.name;
    const filename = exp && !meta.name.toLowerCase().endsWith('.' + exp.ext) ? `${meta.name}.${exp.ext}` : meta.name;
    const library: MediaType = req.library === 'auto' ? (exp ? (exp.mime.startsWith('image/') ? 'image' : 'file') : libraryFor(meta)) : req.library;
    job.library = library;
    const sourceVersion = meta.md5Checksum ?? (meta.modifiedTime ? `mt:${meta.modifiedTime}` : null);

    // 2. duplicate detection (same Drive file, unchanged, still in the library)
    const dup = ctx.db.prepare("SELECT * FROM videos WHERE source_type = 'gdrive' AND source_id = ? AND status = 'active' AND media_type = ? ORDER BY created_at DESC LIMIT 1").get(meta.id, library) as VideoRow | undefined;
    if (dup && (!sourceVersion || !dup.source_md5 || dup.source_md5 === sourceVersion)) {
      job.state = 'done'; job.duplicate = true; fillDone(ctx, job, dup);
      ctx.audit('drive_import_duplicate', { actor: req.actor, ip: req.ip, metadata: { fileId, videoId: dup.id } });
      return { row: dup, duplicate: true };
    }

    // 3. limits and disk space BEFORE downloading
    const expected = meta.size != null ? Number(meta.size) : null;
    job.total = expected;
    if (expected != null && expected > settings.maxUploadBytes) throw new AppError(413, 'file_too_large', `The file is ${expected} bytes, above the maximum allowed size of ${settings.maxUploadBytes} bytes (Settings).`, { maxBytes: settings.maxUploadBytes });
    const space = await diskSpace(ctx.config.dirs.uploads);
    if (space && expected != null && space.freeBytes < expected + 64 * 1024 * 1024) throw new AppError(507, 'insufficient_storage', 'The server does not have enough free disk space for this file.');

    release = await acquire(ctx);

    // 4. stream the real content straight to a temp file (never into RAM)
    tempPath = path.join(ctx.config.dirs.temp, `${randomUUID()}.part`);
    ctx.activeTemps.add(tempPath);
    ctx.audit('drive_download_started', { actor: req.actor, ip: req.ip, metadata: { fileId, size: expected, library } });
    const parsed = await download(ctx, fileId, exp?.mime, meta.mimeType, expected, settings.maxUploadBytes, tempPath, filename, (b) => { job.bytes = b; });
    ctx.audit('drive_download_completed', { actor: req.actor, ip: req.ip, metadata: { fileId, bytes: parsed.size } });
    if (parsed.size === 0) throw new AppError(400, 'empty_file', 'The Google Drive file is empty.');

    // 5. same registration pipeline as a normal upload (content validation, storage, DB record, metadata)
    const failAudit = (e: AppError) => e;
    const { row } = await ingestMedia(ctx, { kind: library, tempPath, parsed, keyId: req.keyId, idemKey: null, actor: req.actor, ip: req.ip, source: { type: 'gdrive', id: meta.id, md5: sourceVersion }, fail: failAudit });
    tempPath = null;
    job.state = 'done'; fillDone(ctx, job, row);
    ctx.audit('drive_import_completed', { actor: req.actor, ip: req.ip, metadata: { fileId, videoId: row.id, mediaType: row.media_type, size: row.size, publicUrl: job.publicUrl } });
    return { row, duplicate: false };
  } catch (e) {
    return fail(ctx, job, req, e as Error);
  } finally {
    if (tempPath) { ctx.activeTemps.delete(tempPath); await fs.promises.unlink(tempPath).catch(() => undefined); }
    release?.();
  }
}

async function download(ctx: Ctx, fileId: string, exportMime: string | undefined, driveMime: string, expected: number | null, maxBytes: number, tempPath: string, filename: string, onBytes: (n: number) => void) {
  const ac = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const stall = () => { ac.abort(new DriveError(502, 'drive_download_failed', 'The download from Google Drive stalled and was cancelled. Try again.')); };
  const res = await driveFetch(ctx, mediaUrl(fileId, exportMime), ac.signal);
  if (!res.ok) throw await mapDriveHttpError(res);
  const ctype = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(ctype) && driveMime !== 'text/html' && !exportMime) { await res.body?.cancel().catch(() => undefined); throw new DriveError(502, 'drive_unexpected_response', 'Google returned a web page instead of the file (access or confirmation page). The file was not imported.'); }
  if (!res.body) throw new DriveError(502, 'drive_download_failed', 'Google Drive returned no content.');
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLen = 0, size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new AppError(413, 'file_too_large', `The download exceeded the maximum allowed size of ${maxBytes} bytes.`));
      hash.update(chunk);
      if (headLen < 4096) { const part = chunk.subarray(0, 4096 - headLen); head.push(part); headLen += part.length; }
      onBytes(size);
      clearTimeout(idle); idle = setTimeout(stall, IDLE_TIMEOUT_MS);
      cb(null, chunk);
    },
  });
  idle = setTimeout(stall, IDLE_TIMEOUT_MS);
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), meter, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }), { signal: ac.signal });
  } catch (e) {
    if (e instanceof AppError) throw e;
    const reason = (ac.signal.reason ?? null) as unknown;
    if (reason instanceof AppError) throw reason;
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new AppError(507, 'insufficient_storage', 'The server ran out of disk space during the download.');
    throw new DriveError(502, 'drive_download_failed', 'The download from Google Drive was interrupted. Nothing was imported; try again.');
  } finally { clearTimeout(idle); }
  if (expected != null && size !== expected) throw new DriveError(502, 'drive_download_incomplete', `The download was incomplete (${size} of ${expected} bytes). Nothing was imported; try again.`);
  return { size, sha256: hash.digest('hex'), head: Buffer.concat(head), filename, clientMime: '' };
}

const SOURCE_KEYS = ['webViewLink', 'driveUrl', 'driveLink', 'driveFileId', 'fileId'];
/** Finds the Google Drive link/ID in an incoming n8n item (top level, or one level down under json/item/data). Returns null when there is none. */
export function pickDriveSource(body: unknown): string | null {
  const look = (o: unknown): string | null => {
    if (!o || typeof o !== 'object') return null;
    const rec = o as Record<string, unknown>;
    for (const k of SOURCE_KEYS) { const v = rec[k]; if (typeof v === 'string' && v.trim()) return v.trim(); }
    if (typeof rec.url === 'string') { try { parseDriveSource(rec.url); return rec.url.trim(); } catch { /* not a Drive link */ } }
    return null;
  };
  const top = Array.isArray(body) ? (body.length === 1 ? body[0] : null) : body;
  const direct = look(top);
  if (direct) return direct;
  if (top && typeof top === 'object') for (const k of ['json', 'item', 'data']) { const v = look((top as Record<string, unknown>)[k]); if (v) return v; }
  return null;
}
