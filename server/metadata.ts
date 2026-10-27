/** Orchestrates metadata extraction for stored media and the background backfill job. Never touches the stored file itself. */
import type { Ctx } from './context';
import { aspectOf, orientationOf, round4, type MediaType } from './mediaTypes';
import { readImageMeta } from './imageMeta';
import { BUILTIN_EXTS, detectFfprobe, hasAnyVideoInfo, probeBuiltin, probeWithFfprobe, type VideoMeta } from './probe';
import { trashPath, uploadPath } from './storage';
import { getVideo, type VideoRow } from './videos';
import { nowIso } from './util';

export type MetadataStatus = 'pending' | 'processing' | 'ready' | 'unavailable' | 'failed';

interface Result {
  status: MetadataStatus; source: string | null; error: string | null;
  durationSeconds?: number | null; width?: number | null; height?: number | null; frameRate?: number | null;
  videoCodec?: string | null; audioCodec?: string | null; imageFormat?: string | null; hasAlpha?: boolean | null; colorSpace?: string | null;
}

const clean = (msg: string, file: string) => msg.split(file).join('<file>').replace(/[A-Za-z]:\\[^\s'"]+|\/[^\s'"]*\/[^\s'"]+/g, '<path>').slice(0, 300);

export async function metadataTools(ctx: Ctx) {
  const ff = await detectFfprobe(ctx.config.ffprobePath);
  return { ffprobe: ff, builtinParser: { available: true, videoFormats: BUILTIN_EXTS, imageFormats: ['jpg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'svg', 'avif', 'heic'] } };
}

async function analyse(ctx: Ctx, row: VideoRow, file: string): Promise<Result> {
  const timeoutMs = ctx.settings().metadataTimeoutSeconds * 1000;
  if (row.media_type === 'file') return { status: 'ready', source: null, error: null };

  if (row.media_type === 'image') {
    try {
      const m = await readImageMeta(file);
      if (!m) return { status: 'unavailable', source: 'builtin', error: 'This image format cannot be analysed by the built-in reader; the file is stored unchanged.' };
      return { status: 'ready', source: 'builtin', error: null, width: m.width, height: m.height, imageFormat: m.format, hasAlpha: m.hasAlpha, colorSpace: m.colorSpace };
    } catch (e) { return { status: 'failed', source: 'builtin', error: clean((e as Error).message, file) }; }
  }

  // video
  const ff = await detectFfprobe(ctx.config.ffprobePath);
  let ffError: string | null = null;
  if (ff.available) {
    try {
      const m = await probeWithFfprobe(ff.path, file, timeoutMs);
      if (hasAnyVideoInfo(m)) return ok(m, 'ffprobe');
      ffError = 'FFprobe found no video information in this file.';
    } catch (e) { ffError = clean((e as Error).message, file); }
  }
  let builtinError: string;
  try {
    const m = await Promise.race([probeBuiltin(file, row.extension), new Promise<null>((_, rej) => setTimeout(() => rej(new Error('Metadata analysis timed out')), timeoutMs).unref())]);
    if (m && hasAnyVideoInfo(m)) return ok(m, 'builtin');
    if (m === null && !BUILTIN_EXTS.includes(row.extension) && !ffError) {
      return { status: 'unavailable', source: null, error: `No analyser available for .${row.extension} files. Install FFprobe (part of FFmpeg) and run "Reprocess metadata".` };
    }
    builtinError = m ? 'No duration or dimensions found.' : 'The file structure could not be read.';
  } catch (e) { builtinError = clean((e as Error).message, file); }
  return { status: 'failed', source: ff.available ? 'ffprobe' : 'builtin', error: ffError ?? builtinError };

  function ok(m: VideoMeta, source: string): Result {
    return { status: 'ready', source, error: null, durationSeconds: m.durationSeconds, width: m.width, height: m.height, frameRate: m.frameRate, videoCodec: m.videoCodec, audioCodec: m.audioCodec };
  }
}

/** Analyse one stored item and persist the result. Safe to call repeatedly (retry / reprocess). */
export async function extractMetadata(ctx: Ctx, id: string): Promise<VideoRow | undefined> {
  const row = getVideo(ctx, id);
  if (!row) return undefined;
  const file = row.status === 'trashed' ? trashPath(ctx, row.storage_name) : uploadPath(ctx, row.storage_name);
  let r: Result;
  try { r = await analyse(ctx, row, file); }
  catch (e) { r = { status: 'failed', source: null, error: clean((e as Error).message, file) }; }
  const w = r.width ?? null, h = r.height ?? null;
  const asp = aspectOf(w, h);
  ctx.db.prepare(`UPDATE videos SET metadata_status = ?, metadata_source = ?, metadata_error = ?, metadata_updated_at = ?,
      duration_seconds = ?, width = ?, height = ?, aspect_ratio = ?, aspect_ratio_value = ?, orientation = ?, frame_rate = ?, video_codec = ?, audio_codec = ?,
      image_format = ?, has_alpha = ?, color_space = ? WHERE id = ?`)
    .run(r.status, r.source, r.error, nowIso(), r.durationSeconds ?? null, w, h, asp?.label ?? null, asp ? round4(asp.value) : null, orientationOf(w, h), r.frameRate ?? null,
      r.videoCodec ?? null, r.audioCodec ?? null, r.imageFormat ?? null, r.hasAlpha == null ? null : r.hasAlpha ? 1 : 0, r.colorSpace ?? null, id);
  if (r.status === 'failed') ctx.log.warn('Metadata extraction failed', { videoId: id, mediaType: row.media_type, error: r.error });
  return getVideo(ctx, id);
}

/** Background, sequential, low-priority metadata job. Returns immediately. */
export function startBackfill(ctx: Ctx, opts: { statuses: MetadataStatus[]; mediaType?: MediaType | 'all' }): { started: boolean; queued: number; running: boolean } {
  if (ctx.metadata.running) return { started: false, queued: 0, running: true };
  const types = opts.mediaType && opts.mediaType !== 'all' ? [opts.mediaType] : ['video', 'image'];
  const rows = ctx.db.prepare(`SELECT id FROM videos WHERE media_type IN (${types.map(() => '?').join(',')}) AND metadata_status IN (${opts.statuses.map(() => '?').join(',')}) ORDER BY created_at DESC`)
    .all(...types, ...opts.statuses) as { id: string }[];
  if (rows.length === 0) return { started: false, queued: 0, running: false };
  ctx.metadata.running = true; ctx.metadata.total = rows.length; ctx.metadata.done = 0;
  const mark = ctx.db.prepare("UPDATE videos SET metadata_status = 'processing' WHERE id = ?");
  ctx.metadata.promise = (async () => {
    try {
      for (const { id } of rows) {
        try { mark.run(id); await extractMetadata(ctx, id); } catch (e) { ctx.log.error('Backfill item failed', { videoId: id, error: (e as Error).message }); }
        ctx.metadata.done++;
        await new Promise((r) => setImmediate(r));
      }
      ctx.audit('metadata_backfill_completed', { actor: 'system', metadata: { processed: rows.length } });
    } finally { ctx.metadata.running = false; ctx.metadata.promise = null; }
  })();
  return { started: true, queued: rows.length, running: true };
}

export function metadataCounts(ctx: Ctx) {
  const rows = ctx.db.prepare('SELECT media_type t, metadata_status s, COUNT(*) c FROM videos GROUP BY media_type, metadata_status').all() as { t: string; s: string; c: number }[];
  const out: Record<string, Record<string, number>> = { video: {}, image: {}, file: {} };
  for (const r of rows) (out[r.t] ??= {})[r.s] = r.c;
  return out;
}
