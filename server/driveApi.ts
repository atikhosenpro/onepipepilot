/** n8n-facing Google Drive import: the existing upload endpoints accept a small JSON body (or a text form field) containing the item's webViewLink. */
import express, { type Request, type RequestHandler, type Response } from 'express';
import type { Ctx } from './context';
import { AppError } from './errors';
import { newJob, pickDriveSource, runImport, type Library } from './driveImport';
import type { MediaType } from './mediaTypes';
import { getVideo, toItem } from './videos';

const LIBRARIES = ['auto', 'video', 'image', 'file'];

export async function respondWithImport(ctx: Ctx, req: Request, res: Response, kind: MediaType, source: string, opts: { library?: unknown; async?: unknown }): Promise<void> {
  let library: Library = kind === 'file' ? 'file' : 'auto'; // /videos and /images auto-route by the real file type; /files always stores a generic file
  if (opts.library !== undefined && opts.library !== null && opts.library !== '') {
    if (typeof opts.library !== 'string' || !LIBRARIES.includes(opts.library)) throw new AppError(400, 'validation_error', 'library must be one of: auto, video, image, file.');
    library = opts.library as Library;
  }
  const keyId = req.apiKey?.id ?? null;
  const job = newJob(ctx, 'api');
  const request = { source, library, keyId, actor: keyId ? `apikey:${keyId}` : null, ip: req.ip ?? null, origin: 'api' as const };
  const wantsAsync = opts.async === true || opts.async === 'true';
  if (wantsAsync) {
    runImport(ctx, request, job).catch(() => undefined); // outcome is recorded on the job
    const statusUrl = `${ctx.settings().publicBaseUrl}/api/v1/imports/${job.id}`;
    res.status(202).json({ success: true, async: true, jobId: job.id, state: job.state, statusUrl });
    return;
  }
  const { row, duplicate } = await runImport(ctx, request, job);
  const item = toItem(row, ctx.settings());
  res.status(duplicate ? 200 : 201).json({ success: true, publicUrl: item.publicUrl, item, source: { type: 'gdrive', fileId: job.fileId }, duplicate });
}

/** Middleware for POST /api/v1/{videos,images,files}: only acts on JSON / urlencoded bodies that contain a Drive link; everything else falls through untouched. */
export function driveJsonImport(ctx: Ctx, kind: MediaType): RequestHandler {
  const json = express.json({ limit: '256kb' });
  const form = express.urlencoded({ extended: false, limit: '256kb' });
  return (req, res, next) => {
    const ct = req.headers['content-type'] ?? '';
    const isJson = /^application\/json/i.test(ct), isForm = /^application\/x-www-form-urlencoded/i.test(ct);
    if (!isJson && !isForm) return next();
    (isJson ? json : form)(req, res, (err?: unknown) => {
      if (err) return next(err);
      const source = pickDriveSource(req.body);
      if (!source) return next(); // not a Drive request: the original upload handler answers exactly as before
      const body = (Array.isArray(req.body) ? req.body[0] : req.body) as Record<string, unknown>;
      respondWithImport(ctx, req, res, kind, source, { library: body?.library, async: body?.async }).catch(next);
    });
  };
}

export function importStatusHandler(ctx: Ctx): RequestHandler {
  return (req, res) => {
    const job = ctx.drive.jobs.get(String(req.params.id));
    if (!job) throw new AppError(404, 'not_found', 'Import job not found (jobs are kept in memory for the most recent 50 imports).');
    const row = job.itemId ? getVideo(ctx, job.itemId) : undefined;
    res.json({ success: true, job: { ...job }, ...(row ? { publicUrl: job.publicUrl, item: toItem(row, ctx.settings()) } : {}) });
  };
}
