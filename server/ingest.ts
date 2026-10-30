/** Shared "register a finished file" step used by multipart uploads AND Google Drive imports: classify, move into storage, insert the record, analyse metadata. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Ctx } from './context';
import { classifyUpload } from './classify';
import type { AppError } from './errors';
import type { MediaType } from './mediaTypes';
import { extractMetadata } from './metadata';
import { uploadPath } from './storage';
import { getVideo, type VideoRow } from './videos';
import { nowIso, sanitizeFilename } from './util';

export interface ParsedFile { size: number; sha256: string; head: Buffer; filename: string; clientMime: string }
export interface IngestArgs {
  kind: MediaType; tempPath: string; parsed: ParsedFile;
  keyId: string | null; idemKey: string | null; actor: string | null; ip: string | null;
  source?: { type: string; id: string; md5: string | null };
  fail: (e: AppError, extra?: Record<string, unknown>) => AppError;
}

/**
 * The file at `tempPath` must be complete. On success it has been renamed into storage and registered; on any failure the stored copy is removed
 * (the caller still owns cleanup of `tempPath`). Nothing becomes visible in the library before the record exists.
 */
export async function ingestMedia(ctx: Ctx, a: IngestArgs): Promise<{ row: VideoRow; mime: string }> {
  const settings = ctx.settings();
  const cls = classifyUpload(a.kind, a.parsed, settings, a.fail);
  const id = randomUUID();
  const storageName = `${id}.${cls.ext}`;
  const finalPath = uploadPath(ctx, storageName);
  if (fs.existsSync(finalPath)) throw new Error('Storage name collision.'); // practically impossible
  await fs.promises.rename(a.tempPath, finalPath);
  ctx.activeTemps.delete(a.tempPath);
  const now = nowIso();
  try {
    ctx.db.transaction(() => {
      ctx.db.prepare(`INSERT INTO videos (id, original_name, storage_name, mime_type, extension, size, sha256, status, created_at, updated_at, api_key_id, idempotency_key, media_type, category, metadata_status, source_type, source_id, source_md5)
        VALUES (?,?,?,?,?,?,?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sanitizeFilename(a.parsed.filename), storageName, cls.mime, cls.ext, a.parsed.size, a.parsed.sha256, now, now, a.keyId, a.idemKey, a.kind, cls.category,
          a.kind === 'file' ? 'ready' : 'pending', a.source?.type ?? null, a.source?.id ?? null, a.source?.md5 ?? null);
    })();
  } catch (e) {
    await fs.promises.unlink(finalPath).catch(() => undefined);
    throw e;
  }
  // Analyse right away (fast header parsing). Failure never affects the stored file: the item just reports metadataStatus.
  let row = getVideo(ctx, id) as VideoRow;
  if (a.kind !== 'file') row = (await extractMetadata(ctx, id).catch(() => undefined)) ?? row;
  ctx.audit(`${a.kind}_uploaded`, { actor: a.actor, ip: a.ip, metadata: { videoId: id, mediaType: a.kind, size: a.parsed.size, mimeType: cls.mime, originalName: row.original_name, metadataStatus: row.metadata_status, ...(a.source ? { source: a.source.type } : {}) } });
  return { row, mime: cls.mime };
}
