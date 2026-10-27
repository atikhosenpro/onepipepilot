import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Ctx } from './context';
import { bearerAuth } from './auth';
import { AppError, asyncHandler, errorBody, parseWith } from './errors';
import { mediaQuerySchema, toListOpts } from './mediaQuery';
import type { MediaType } from './mediaTypes';
import { extractMetadata } from './metadata';
import { uploadHandler } from './upload';
import { listVideos, requireVideo, toItem, trashVideo } from './videos';

const LIBRARIES: { kind: MediaType; path: string }[] = [
  { kind: 'video', path: '/videos' }, { kind: 'image', path: '/images' }, { kind: 'file', path: '/files' },
];

export function apiRouter(ctx: Ctx): Router {
  const r = Router();
  const rl = ctx.config.rateLimits;
  const uploadLimiter = rateLimit({
    windowMs: rl.uploadWindowMs, limit: rl.uploadMax, standardHeaders: 'draft-7', legacyHeaders: false, validate: false,
    handler: (_req, res) => { res.set('Connection', 'close').status(429).json(errorBody('rate_limited', 'Too many requests. Slow down and retry later.')); },
  });

  r.get('/health', (_req, res) => {
    let db = true;
    try { ctx.db.prepare('SELECT 1').get(); } catch { db = false; }
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'error', app: 'local-video-host', time: new Date().toISOString() });
  });

  const auth = bearerAuth(ctx);
  for (const { kind, path } of LIBRARIES) {
    const label = kind === 'file' ? 'File' : kind[0].toUpperCase() + kind.slice(1);
    const own = (id: string) => {
      const row = requireVideo(ctx, id);
      if (row.media_type !== kind) throw new AppError(404, 'not_found', `${label} not found.`);
      return row;
    };

    r.post(path, uploadLimiter, auth, asyncHandler(uploadHandler(ctx, kind)));

    // List: all filters combine with AND, are validated, and run as SQL (never in memory). Default status=active.
    r.get(path, uploadLimiter, auth, (req, res) => {
      const q = parseWith(mediaQuerySchema, req.query);
      res.json({ success: true, ...listVideos(ctx, toListOpts(q, { mediaType: kind })) });
    });

    r.get(`${path}/:id`, uploadLimiter, auth, (req, res) => {
      const row = own(req.params.id);
      if (row.status !== 'active') throw new AppError(404, 'not_found', `${label} not found.`);
      res.json({ success: true, item: toItem(row, ctx.settings()) });
    });

    // Re-run metadata extraction (e.g. after installing FFprobe). Never modifies the stored file.
    if (kind !== 'file') {
      r.post(`${path}/:id/reprocess`, uploadLimiter, auth, asyncHandler(async (req, res) => {
        const row = own(req.params.id);
        if (row.status !== 'active') throw new AppError(404, 'not_found', `${label} not found.`);
        const updated = await extractMetadata(ctx, row.id);
        res.json({ success: true, item: toItem(updated ?? row, ctx.settings()) });
      }));
    }

    r.delete(`${path}/:id`, uploadLimiter, auth, express.json({ limit: '1kb' }), asyncHandler(async (req, res) => {
      own(req.params.id);
      const result = await trashVideo(ctx, req.params.id, `apikey:${req.apiKey!.id}`, req.ip);
      if (!result.ok) throw new AppError(result.error === 'not_found' ? 404 : 409, result.error ?? 'error', result.error === 'not_found' ? `${label} not found.` : `The ${kind} could not be moved to trash.`);
      res.json({ success: true, id: req.params.id, status: 'trashed' });
    }));
  }

  r.use((_req, _res, next) => next(new AppError(404, 'not_found', 'Unknown endpoint.')));
  return r;
}
