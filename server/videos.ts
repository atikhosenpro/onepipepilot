import fs from 'node:fs';
import type { Ctx } from './context';
import { AppError } from './errors';
import type { Settings } from './settings';
import { moveFile, trashPath, uploadPath } from './storage';
import { escapeLike, nowIso, zonedDayStartUtc } from './util';
import { URL_PREFIX, formatDuration, humanSize, parseAspectQuery, round2, round4, resolutionCategoryOf, type MediaType } from './mediaTypes';

export interface VideoRow {
  id: string; original_name: string; storage_name: string; mime_type: string; extension: string; size: number; sha256: string;
  status: 'active' | 'trashed'; created_at: string; updated_at: string; trashed_at: string | null; deleted_at: string | null;
  api_key_id: string | null; idempotency_key: string | null;
  media_type: MediaType; category: string | null; metadata_status: string; metadata_source: string | null; metadata_error: string | null; metadata_updated_at: string | null;
  duration_seconds: number | null; width: number | null; height: number | null; aspect_ratio: string | null; aspect_ratio_value: number | null; orientation: string | null;
  frame_rate: number | null; video_codec: string | null; audio_codec: string | null; image_format: string | null; has_alpha: number | null; color_space: string | null;
  source_type: string | null; source_id: string | null; source_md5: string | null;
}

export const publicUrlFor = (base: string, row: Pick<VideoRow, 'id' | 'extension'> & { media_type?: MediaType }) => `${base}${URL_PREFIX[row.media_type ?? 'video']}/${row.id}.${row.extension}`;

export function toItem(row: VideoRow, settings: Settings) {
  const url = publicUrlFor(settings.publicBaseUrl, row);
  const active = row.status === 'active';
  const mediaType = row.media_type ?? 'video';
  const item: Record<string, unknown> = {
    // original fields (unchanged names and meaning)
    id: row.id, originalName: row.original_name, mimeType: row.mime_type, extension: row.extension, size: row.size, sha256: row.sha256,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, trashedAt: row.trashed_at,
    publicUrl: active ? url : null, downloadUrl: active ? `${url}?download=1` : null,
    // additive fields for automation clients
    mediaType, fileName: row.original_name, sizeBytes: row.size, sizeKB: round2(row.size / 1024), sizeMB: round2(row.size / 1048576), sizeGB: round4(row.size / 1073741824),
    sizeFormatted: humanSize(row.size), uploadedAt: row.created_at,
    metadataStatus: row.metadata_status, metadataSource: row.metadata_source, metadataError: row.metadata_error,
  };
  const w = row.width, h = row.height;
  const dims = { width: w, height: h, resolution: w && h ? `${w}x${h}` : null, aspectRatio: row.aspect_ratio, aspectRatioValue: row.aspect_ratio_value, orientation: row.orientation };
  if (mediaType === 'video') {
    const d = row.duration_seconds;
    const isShort = d == null ? null : d <= settings.shortVideoMaxSeconds;
    Object.assign(item, {
      durationSeconds: d, durationFormatted: formatDuration(d), durationMinutes: d == null ? null : round4(d / 60), ...dims,
      resolutionCategory: resolutionCategoryOf(w, h), frameRate: row.frame_rate, videoCodec: row.video_codec, audioCodec: row.audio_codec,
      videoClass: isShort == null ? null : isShort ? 'short' : 'long', isShort,
    });
  } else if (mediaType === 'image') {
    Object.assign(item, { ...dims, imageFormat: row.image_format, hasAlpha: row.has_alpha == null ? null : row.has_alpha === 1, colorSpace: row.color_space });
  } else {
    Object.assign(item, { category: row.category });
  }
  return item;
}

const SORTS: Record<string, string> = {
  createdAt: 'created_at', uploadedAt: 'created_at', originalName: 'original_name', fileName: 'original_name', size: 'size', sizeBytes: 'size', id: 'id', status: 'status',
  trashedAt: 'trashed_at', duration: 'duration_seconds', durationSeconds: 'duration_seconds', width: 'width', height: 'height', extension: 'extension',
};
export const SORT_KEYS = Object.keys(SORTS);

export interface ListOpts {
  mediaType?: MediaType | 'all'; status?: 'active' | 'trashed' | 'all'; q?: string; sort?: string; order?: 'asc' | 'desc'; page?: number; pageSize?: number;
  extension?: string; mimeType?: string; type?: string; category?: string; imageFormat?: string;
  minSizeMB?: number; maxSizeMB?: number; minDuration?: number; maxDuration?: number; aspectRatio?: string; orientation?: string;
  minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number; resolution?: string; resolutionCategory?: string;
  videoClass?: 'short' | 'long'; metadataStatus?: string; uploadedFrom?: string; uploadedTo?: string;
}

function dateBound(input: string, tz: string, end: boolean): { iso: string; exclusive: boolean } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (m) {
    const start = zonedDayStartUtc(tz, Number(m[1]), Number(m[2]), Number(m[3]));
    if (!end) return { iso: start.toISOString(), exclusive: false };
    return { iso: zonedDayStartUtc(tz, Number(m[1]), Number(m[2]), Number(m[3]) + 1).toISOString(), exclusive: true };
  }
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new AppError(400, 'validation_error', `"${input}" is not a valid date (use YYYY-MM-DD or an ISO date-time).`);
  return { iso: new Date(t).toISOString(), exclusive: false };
}

/** Builds the WHERE clause for list queries. Every filter is optional and filters combine with AND. */
function buildWhere(opts: ListOpts, settings: Settings): { sql: string; params: unknown[] } {
  const where: string[] = []; const params: unknown[] = [];
  const mt = opts.mediaType ?? 'video';
  if (mt !== 'all') { where.push('media_type = ?'); params.push(mt); }
  if (opts.status && opts.status !== 'all') { where.push('status = ?'); params.push(opts.status); }
  const q = opts.q?.trim();
  if (q) { where.push("(id LIKE ? ESCAPE '\\' OR original_name LIKE ? ESCAPE '\\')"); params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`); }
  const list = (v?: string) => (v ? v.split(',').map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean) : []);
  const exts = list(opts.extension);
  if (exts.length) { where.push(`extension IN (${exts.map(() => '?').join(',')})`); params.push(...exts); }
  const mimeFilter = (col: string, v: string) => { const x = v.trim().toLowerCase(); if (x.endsWith('/*') || x.endsWith('*')) { where.push(`${col} LIKE ? ESCAPE '\\'`); params.push(escapeLike(x.replace(/\*$/, '')) + '%'); } else { where.push(`${col} = ?`); params.push(x); } };
  if (opts.mimeType) mimeFilter('mime_type', opts.mimeType);
  if (opts.type) { const t = opts.type.trim().toLowerCase().replace(/^\./, ''); if (t.includes('/')) mimeFilter('mime_type', t); else { where.push('extension = ?'); params.push(t); } }
  if (opts.category) { where.push('category = ?'); params.push(opts.category.toLowerCase()); }
  if (opts.imageFormat) { where.push('LOWER(image_format) = ?'); params.push(opts.imageFormat.toLowerCase()); }
  const range = (col: string, min?: number, max?: number, scale = 1) => {
    if (min != null) { where.push(`${col} >= ?`); params.push(min * scale); }
    if (max != null) { where.push(`${col} <= ?`); params.push(max * scale); }
  };
  range('size', opts.minSizeMB, opts.maxSizeMB, 1048576);
  range('duration_seconds', opts.minDuration, opts.maxDuration);
  range('width', opts.minWidth, opts.maxWidth);
  range('height', opts.minHeight, opts.maxHeight);
  if (opts.aspectRatio) {
    const v = parseAspectQuery(opts.aspectRatio);
    if (v == null) throw new AppError(400, 'validation_error', `aspectRatio "${opts.aspectRatio}" is not valid. Use e.g. 16:9, 9:16, 1:1, 4:5 or a number such as 0.5625.`);
    where.push('aspect_ratio_value BETWEEN ? AND ?'); params.push(v * 0.99, v * 1.01);
  }
  if (opts.orientation) { where.push('orientation = ?'); params.push(opts.orientation); }
  if (opts.resolution) {
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(opts.resolution.trim());
    if (!m) throw new AppError(400, 'validation_error', `resolution "${opts.resolution}" is not valid. Use WIDTHxHEIGHT, e.g. 1920x1080.`);
    where.push('width = ? AND height = ?'); params.push(Number(m[1]), Number(m[2]));
  }
  if (opts.resolutionCategory) {
    const c = opts.resolutionCategory;
    const bounds: Record<string, [number, number]> = { '4K': [2160, 1e9], '1440p': [1440, 2160], '1080p': [1080, 1440], '720p': [720, 1080], '480p': [480, 720], '360p': [360, 480], '240p': [240, 360], 'below-240p': [0, 240] };
    const bd = bounds[c];
    if (!bd) throw new AppError(400, 'validation_error', `resolutionCategory must be one of ${Object.keys(bounds).join(', ')}.`);
    where.push('MIN(width, height) >= ? AND MIN(width, height) < ?'); params.push(bd[0], bd[1]);
  }
  if (opts.videoClass === 'short') { where.push('duration_seconds IS NOT NULL AND duration_seconds <= ?'); params.push(settings.shortVideoMaxSeconds); }
  if (opts.videoClass === 'long') { where.push('duration_seconds IS NOT NULL AND duration_seconds > ?'); params.push(settings.shortVideoMaxSeconds); }
  if (opts.metadataStatus) { where.push('metadata_status = ?'); params.push(opts.metadataStatus); }
  if (opts.uploadedFrom) { const b = dateBound(opts.uploadedFrom, settings.timeZone, false); where.push('created_at >= ?'); params.push(b.iso); }
  if (opts.uploadedTo) { const b = dateBound(opts.uploadedTo, settings.timeZone, true); where.push(b.exclusive ? 'created_at < ?' : 'created_at <= ?'); params.push(b.iso); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listVideos(ctx: Ctx, opts: ListOpts) {
  const settings = ctx.settings();
  const { sql: w, params } = buildWhere(opts, settings);
  const sortCol = SORTS[opts.sort ?? ''] ?? 'created_at';
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const total = (ctx.db.prepare(`SELECT COUNT(*) c FROM videos ${w}`).get(...params) as { c: number }).c;
  // rows without a value (e.g. unknown duration) always sort last
  const rows = ctx.db.prepare(`SELECT * FROM videos ${w} ORDER BY ${sortCol} IS NULL, ${sortCol} ${order}, id ASC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as VideoRow[];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { items: rows.map((r) => toItem(r, settings)), page, pageSize, limit: pageSize, total, totalPages, hasMore: page < totalPages };
}

export function getVideo(ctx: Ctx, id: string): VideoRow | undefined {
  return ctx.db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined;
}

export interface BulkResult { id: string; ok: boolean; error?: string }

export async function trashVideo(ctx: Ctx, id: string, actor: string | null, ip?: string | null): Promise<BulkResult> {
  const row = getVideo(ctx, id);
  if (!row) return { id, ok: false, error: 'not_found' };
  if (row.status !== 'active') return { id, ok: false, error: 'already_trashed' };
  const src = uploadPath(ctx, row.storage_name), dst = trashPath(ctx, row.storage_name);
  let moved = false;
  try {
    try { await moveFile(src, dst); moved = true; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      ctx.audit('storage_error', { actor, ip, metadata: { op: 'trash', videoId: id, error: 'physical file missing' } });
    }
    const now = nowIso();
    ctx.db.prepare("UPDATE videos SET status = 'trashed', trashed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(now, now, id);
    ctx.audit('video_trashed', { actor, ip, metadata: { videoId: id, originalName: row.original_name } });
    return { id, ok: true };
  } catch (e) {
    if (moved) await moveFile(dst, src).catch(() => undefined);
    ctx.audit('storage_error', { actor, ip, metadata: { op: 'trash', videoId: id, error: (e as Error).message } });
    return { id, ok: false, error: 'storage_error' };
  }
}

export async function restoreVideo(ctx: Ctx, id: string, actor: string | null, ip?: string | null): Promise<BulkResult> {
  const row = getVideo(ctx, id);
  if (!row) return { id, ok: false, error: 'not_found' };
  if (row.status !== 'trashed') return { id, ok: false, error: 'not_trashed' };
  const src = trashPath(ctx, row.storage_name), dst = uploadPath(ctx, row.storage_name);
  let moved = false;
  try {
    try { await moveFile(src, dst); moved = true; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { id, ok: false, error: 'file_missing' };
      throw e;
    }
    ctx.db.prepare("UPDATE videos SET status = 'active', trashed_at = NULL, updated_at = ? WHERE id = ? AND status = 'trashed'").run(nowIso(), id);
    ctx.audit('video_restored', { actor, ip, metadata: { videoId: id } });
    return { id, ok: true };
  } catch (e) {
    if (moved) await moveFile(dst, src).catch(() => undefined);
    ctx.audit('storage_error', { actor, ip, metadata: { op: 'restore', videoId: id, error: (e as Error).message } });
    return { id, ok: false, error: 'storage_error' };
  }
}

/** Permanently delete a TRASHED video (file first, then record). */
export async function purgeVideo(ctx: Ctx, id: string, actor: string | null, ip?: string | null): Promise<BulkResult> {
  const row = getVideo(ctx, id);
  if (!row) return { id, ok: false, error: 'not_found' };
  if (row.status !== 'trashed') return { id, ok: false, error: 'not_trashed' };
  try {
    try { await fs.promises.unlink(trashPath(ctx, row.storage_name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    ctx.db.prepare("DELETE FROM videos WHERE id = ? AND status = 'trashed'").run(id);
    ctx.audit('video_deleted', { actor, ip, metadata: { videoId: id, originalName: row.original_name, size: row.size } });
    return { id, ok: true };
  } catch (e) {
    ctx.audit('storage_error', { actor, ip, metadata: { op: 'purge', videoId: id, error: (e as Error).message } });
    return { id, ok: false, error: 'storage_error' };
  }
}

export async function bulk(ids: string[], fn: (id: string) => Promise<BulkResult>): Promise<{ results: BulkResult[]; succeeded: number; failed: number }> {
  const results: BulkResult[] = [];
  for (const id of ids) results.push(await fn(id));
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}

export function trashedIds(ctx: Ctx, olderThanIso?: string): string[] {
  const rows = olderThanIso
    ? ctx.db.prepare("SELECT id FROM videos WHERE status = 'trashed' AND trashed_at <= ?").all(olderThanIso)
    : ctx.db.prepare("SELECT id FROM videos WHERE status = 'trashed'").all();
  return (rows as { id: string }[]).map((r) => r.id);
}

export function requireVideo(ctx: Ctx, id: string): VideoRow {
  const row = getVideo(ctx, id);
  if (!row) throw new AppError(404, 'not_found', 'Video not found.');
  return row;
}
