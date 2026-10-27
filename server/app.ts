import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { adminRouter } from './adminRoutes';
import { apiRouter } from './apiRoutes';
import { ensureSetupToken } from './auth';
import { loadConfig, type AppConfig } from './config';
import { createContext, type Ctx } from './context';
import { createErrorHandler, errorBody } from './errors';
import { startScheduler, runMaintenance } from './maintenance';
import { startBackfill } from './metadata';
import { publicVideoHandler } from './publicVideos';
import { cleanTemp } from './storage';

export interface BuiltApp { app: Express; ctx: Ctx; attachDev?: (server: Server) => Promise<void>; close(): void }

export interface BuildOptions { config?: Partial<AppConfig>; silent?: boolean }

export function buildApp(opts: BuildOptions = {}): BuiltApp {
  const config = loadConfig(opts.config);
  const ctx = createContext(config, { silent: opts.silent });
  ensureSetupToken(ctx);
  // Leftovers from a crashed previous run (nothing is in flight at startup).
  cleanTemp(ctx, 60 * 60_000).catch(() => undefined);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(helmet({
    contentSecurityPolicy: config.devMode ? false : {
      useDefaults: true,
      directives: { 'default-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'media-src': ["'self'", 'blob:'], 'style-src': ["'self'", "'unsafe-inline'"], 'script-src': ["'self'"], 'connect-src': ["'self'", 'https://formsubmit.co'], 'frame-ancestors': ["'none'"], 'object-src': ["'none'"], 'upgrade-insecure-requests': null },
    },
    strictTransportSecurity: { maxAge: 15552000 },
  }));

  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/v1', apiRouter(ctx));
  app.use('/api/admin', adminRouter(ctx));
  app.use('/api', (_req, res) => res.status(404).json(errorBody('not_found', 'Unknown endpoint.')));

  // Public, unauthenticated file delivery. /videos is the original route and keeps working unchanged.
  for (const [prefix, kind] of [['/videos', 'video'], ['/images', 'image'], ['/files', 'file']] as const) {
    const serve = publicVideoHandler(ctx, kind);
    app.get(`${prefix}/:file`, serve);
    app.head(`${prefix}/:file`, serve);
    app.all(`${prefix}/:file`, (_req, res) => res.set('Allow', 'GET, HEAD').status(405).json(errorBody('method_not_allowed', 'Use GET or HEAD.')));
    // No directory listing. The bare path ("/videos", "/images", "/files") is also a dashboard page, so a plain GET/HEAD of exactly that
    // path is passed on to the dashboard (hard refresh!). Anything deeper that is not a valid file is still a JSON 404.
    app.use(prefix, (req, res, next) => {
      if (req.path === '/' && (req.method === 'GET' || req.method === 'HEAD')) return next();
      res.status(404).json(errorBody('not_found', 'Not found.'));
    });
  }

  const built: BuiltApp = { app, ctx, close() { ctx.timers.forEach(clearTimeout); try { ctx.db.close(); } catch { /* closed */ } } };

  if (config.devMode) {
    built.attachDev = async (server: Server) => {
      const { createServer } = await import('vite');
      const vite = await createServer({ configFile: path.join(config.projectRoot, 'vite.config.mts'), appType: 'spa', server: { middlewareMode: true, hmr: { server } } });
      app.use(vite.middlewares);
      app.use(createErrorHandler((m, x) => ctx.log.error(m, x)));
    };
  } else {
    const index = path.join(config.webDist, 'index.html');
    if (fs.existsSync(index)) {
      app.use(express.static(config.webDist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable'); } }));
      app.get(/^\/(?!api\/|(?:videos|images|files)\/.).*/, (_req, res) => { res.set('Cache-Control', 'no-store').sendFile(index); });
    } else {
      app.get('/', (_req, res) => res.status(503).type('text/plain').send('The dashboard has not been built yet. Run "npm run build" first.'));
      app.use((_req, res) => res.status(404).json(errorBody('not_found', 'Not found.')));
    }
    app.use(createErrorHandler((m, x) => ctx.log.error(m, x)));
  }
  // Items that were interrupted mid-analysis go back to the queue.
  ctx.db.prepare("UPDATE videos SET metadata_status = 'pending' WHERE metadata_status = 'processing'").run();
  if (config.enableScheduler) {
    startScheduler(ctx);
    // Existing videos (uploaded before this feature) are analysed once, in the background.
    const t = setTimeout(() => { try { startBackfill(ctx, { statuses: ['pending'] }); } catch (e) { ctx.log.error('Backfill failed to start', { error: (e as Error).message }); } }, 5000);
    t.unref(); ctx.timers.push(t);
  }
  return built;
}

export { runMaintenance };
