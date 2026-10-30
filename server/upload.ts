import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import type { Request, Response } from 'express';
import type { Ctx } from './context';
import { AppError } from './errors';
import { ingestMedia } from './ingest';
import type { MediaType } from './mediaTypes';
import { diskSpace } from './storage';
import { pickDriveSource } from './driveImport';
import { respondWithImport } from './driveApi';
import { toItem, type VideoRow } from './videos';

interface Parsed { size: number; sha256: string; head: Buffer; filename: string; clientMime: string }
/** A multipart request that carried only a Drive link (text field) and no file. */
interface DriveField { driveSource: string; fields: Record<string, string> }

const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export function uploadHandler(ctx: Ctx, kind: MediaType = 'video') {
  return async (req: Request, res: Response): Promise<void> => {
    const settings = ctx.settings();
    const keyId = req.apiKey?.id ?? null;
    const ip = req.ip ?? null;
    const fail = (e: AppError, extra: Record<string, unknown> = {}) => {
      ctx.audit('upload_failed', { actor: keyId ? `apikey:${keyId}` : null, ip, metadata: { code: e.code, ...extra } });
      return e;
    };

    if (!/^multipart\/form-data/i.test(req.headers['content-type'] ?? '')) {
      throw fail(new AppError(415, 'unsupported_content_type', 'Content-Type must be multipart/form-data with the video in a file field (an n8n "Form-Data" body with parameter type "n8n Binary File").'));
    }

    // Optional, scoped idempotency (per API key).
    const idemRaw = req.headers['idempotency-key'];
    let idemKey: string | null = null;
    if (idemRaw !== undefined) {
      if (typeof idemRaw !== 'string' || !IDEMPOTENCY_RE.test(idemRaw)) throw fail(new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-128 characters: letters, digits, "_", "-", ".", ":".'));
      idemKey = idemRaw;
      const existing = ctx.db.prepare('SELECT * FROM videos WHERE api_key_id = ? AND idempotency_key = ?').get(keyId, idemKey) as VideoRow | undefined;
      if (existing) {
        if (existing.media_type !== kind) throw new AppError(409, 'idempotency_key_conflict', `This Idempotency-Key was already used for a ${existing.media_type} upload.`);
        if (existing.status !== 'active') throw new AppError(409, 'idempotency_key_conflict', 'A video uploaded with this Idempotency-Key is in the trash. Use a new key to upload again.');
        const item = toItem(existing, settings);
        res.set('Connection', 'close');
        res.status(200).json({ success: true, idempotentReplay: true, publicUrl: item.publicUrl, item });
        return;
      }
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > settings.maxUploadBytes + 1024 * 1024) {
      throw fail(new AppError(413, 'file_too_large', `Upload exceeds the maximum allowed size of ${settings.maxUploadBytes} bytes.`, { maxBytes: settings.maxUploadBytes }));
    }
    if (Number.isFinite(declared) && declared > 0) {
      const space = await diskSpace(ctx.config.dirs.uploads);
      if (space && space.freeBytes < declared + 64 * 1024 * 1024) {
        throw fail(new AppError(507, 'insufficient_storage', 'The server does not have enough free disk space for this upload.'));
      }
    }

    const tempPath = path.join(ctx.config.dirs.temp, `${randomUUID()}.part`);
    ctx.activeTemps.add(tempPath);
    try {
      const received = await receive(req, tempPath, settings.fieldName, settings.maxUploadBytes, fail);
      if ('driveSource' in received) { // n8n sent form fields only (e.g. webViewLink): import from Google Drive instead of reading a file
        ctx.activeTemps.delete(tempPath);
        await respondWithImport(ctx, req, res, kind, received.driveSource, { library: received.fields.library, async: received.fields.async });
        return;
      }
      const parsed = received;
      if (parsed.size === 0) throw fail(new AppError(400, 'empty_file', 'The uploaded file is empty.'));

      let row: VideoRow;
      try {
        ({ row } = await ingestMedia(ctx, { kind, tempPath, parsed, keyId, idemKey, actor: `apikey:${keyId}`, ip, fail }));
      } catch (e) {
        if (idemKey && /UNIQUE/i.test((e as Error).message)) {
          const winner = ctx.db.prepare('SELECT * FROM videos WHERE api_key_id = ? AND idempotency_key = ?').get(keyId, idemKey) as VideoRow | undefined;
          if (winner?.status === 'active') {
            const item = toItem(winner, settings);
            res.status(200).json({ success: true, idempotentReplay: true, publicUrl: item.publicUrl, item });
            return;
          }
        }
        throw e;
      }
      const item = toItem(row, settings);
      res.status(201).json({ success: true, publicUrl: item.publicUrl, item });
    } catch (e) {
      ctx.activeTemps.delete(tempPath);
      await fs.promises.unlink(tempPath).catch(() => undefined);
      if (e instanceof AppError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') throw fail(new AppError(507, 'insufficient_storage', 'The server ran out of disk space during the upload.'));
      ctx.audit('storage_error', { actor: keyId ? `apikey:${keyId}` : null, ip, metadata: { op: 'upload', error: (e as Error).message, code } });
      throw fail(new AppError(500, 'internal_error', 'The upload could not be saved.'));
    }
  };
}

/** Stream the single file part to `tempPath` on disk, hashing as it goes. Never buffers the file in memory. */
function receive(req: Request, tempPath: string, fieldName: string, maxBytes: number, fail: (e: AppError, x?: Record<string, unknown>) => AppError): Promise<Parsed | DriveField> {
  return new Promise<Parsed | DriveField>((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 10_000, parts: 15 } });
    } catch {
      return reject(fail(new AppError(400, 'invalid_multipart', 'The multipart request is malformed (missing boundary?). Let your HTTP client set the Content-Type header itself.')));
    }
    let settled = false;
    let seenFile = false;
    let pending: Error | null = null;
    let filePromise: Promise<Parsed> | null = null;
    let outStream: fs.WriteStream | null = null;

    const fields: Record<string, string> = {};
    const finish = (err: Error | null, value?: Parsed | DriveField) => {
      if (settled) return;
      settled = true;
      req.unpipe(bb);
      outStream?.destroy();
      if (err) reject(err); else resolve(value as Parsed);
    };

    bb.on('file', (name, stream, info) => {
      if (seenFile) { pending ??= fail(new AppError(400, 'multiple_files', 'Send exactly one file per request.')); stream.resume(); return; }
      seenFile = true;
      if (name !== fieldName) {
        pending = fail(new AppError(400, 'unexpected_field', `The video must be sent in the multipart field "${fieldName}", but the file arrived in "${name}".`, { expectedField: fieldName, receivedField: name }));
        stream.resume();
        return;
      }
      const hash = createHash('sha256');
      const headChunks: Buffer[] = [];
      let headLen = 0, size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk); size += chunk.length;
          if (headLen < 4096) { const part = chunk.subarray(0, 4096 - headLen); headChunks.push(part); headLen += part.length; }
          cb(null, chunk);
        },
      });
      stream.on('limit', () => finish(fail(new AppError(413, 'file_too_large', `The file exceeds the maximum allowed size of ${maxBytes} bytes.`, { maxBytes }))));
      outStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
      filePromise = pipeline(stream, meter, outStream).then(() => ({
        size, sha256: hash.digest('hex'), head: Buffer.concat(headChunks), filename: info.filename ?? '', clientMime: info.mimeType ?? '',
      }));
      filePromise.catch(() => undefined);
    });
    bb.on('field', (name, val) => { if (typeof val === 'string' && val.length <= 4096) fields[name] = val; });
    bb.on('error', () => finish(fail(new AppError(400, 'invalid_multipart', 'The multipart request body is malformed.'))));
    bb.on('partsLimit', () => finish(fail(new AppError(400, 'invalid_multipart', 'Too many multipart parts.'))));
    bb.on('close', async () => {
      if (settled) return;
      if (pending) return finish(pending);
      if (!filePromise) { const src = pickDriveSource(fields); if (src) return finish(null, { driveSource: src, fields }); }
      if (!filePromise) return finish(fail(new AppError(400, 'missing_file', `No file received. Send the video in the multipart field "${fieldName}".`, { expectedField: fieldName })));
      try { finish(null, await filePromise); }
      catch (e) { finish(settled ? null : (e as Error)); }
    });
    req.on('error', () => finish(fail(new AppError(400, 'upload_aborted', 'The upload was interrupted.'))));
    req.on('close', () => { if (!req.complete) finish(fail(new AppError(400, 'upload_aborted', 'The upload was interrupted.'))); });
    req.pipe(bb);
  });
}
