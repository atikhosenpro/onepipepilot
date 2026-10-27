import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import express from 'express';
import { z } from 'zod';
import type { Ctx } from './context';
import {
  burnPasswordTime, consumeSetupTokenCheck, createApiKey, createSession, csrfGuard, destroySession, hashPassword, invalidateOtherSessions,
  listApiKeys, originGuard, passwordProblems, requireAdmin, sessionLoader, usernameSchema, verifyPassword,
} from './auth';
import { kvDelete, kvGet, kvSet } from './db';
import { diagnostics, storageReport } from './diagnostics';
import { AppError, asyncHandler, errorBody, parseWith } from './errors';
import { listOrphans, runMaintenance } from './maintenance';
import { getSettings, normalizeBaseUrl, settingsPatchSchema, updateSettings } from './settings';
import { cleanTemp, diskSpace } from './storage';
import { mediaQuerySchema, toListOpts } from './mediaQuery';
import { extractMetadata, metadataCounts, metadataTools, startBackfill } from './metadata';
import { bulk, getVideo, listVideos, purgeVideo, requireVideo, restoreVideo, toItem, trashedIds, trashVideo } from './videos';
import { nowIso, startOfTodayUtc } from './util';
import fs from 'node:fs';

const ids = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

export function adminRouter(ctx: Ctx): Router {
  const r = Router();
  const rl = ctx.config.rateLimits;
  const limiterHandler = (code: string, msg: string): RequestHandler => (_req, res) => {
    res.status(429).json(errorBody(code, msg));
  };
  const loginLimiter = rateLimit({ windowMs: rl.loginWindowMs, limit: rl.loginMax, standardHeaders: 'draft-7', legacyHeaders: false, validate: false, handler: limiterHandler('rate_limited', 'Too many sign-in attempts. Try again later.') });
  const setupLimiter = rateLimit({ windowMs: rl.loginWindowMs, limit: rl.setupMax, standardHeaders: 'draft-7', legacyHeaders: false, validate: false, handler: limiterHandler('rate_limited', 'Too many setup attempts. Try again later.') });
  const generalLimiter = rateLimit({ windowMs: 15 * 60_000, limit: rl.adminMax, standardHeaders: 'draft-7', legacyHeaders: false, validate: false, handler: limiterHandler('rate_limited', 'Too many requests.') });

  r.use(generalLimiter, express.json({ limit: '100kb' }), originGuard(ctx), sessionLoader(ctx));
  const actor = (req: Express.Request) => (req.admin ? `admin:${req.admin.username}` : null);
  const adminCount = () => (ctx.db.prepare('SELECT COUNT(*) c FROM admins').get() as { c: number }).c;

  // Onboarding counts as done once it was submitted/skipped, or when an admin already exists (installs that pre-date onboarding never see it).
  const onboardingDone = () => kvGet(ctx.db, 'onboarding_done') !== null || adminCount() > 0;

  r.get('/session', (req, res) => {
    res.json({
      success: true, setupRequired: adminCount() === 0, onboardingDone: onboardingDone(), authenticated: !!req.admin, username: req.admin?.username ?? null,
      csrfToken: req.admin?.csrfToken ?? null, version: ctx.config.version, settings: req.admin ? ctx.settings() : null,
    });
  });

  // ----- first-run setup -----
  r.post('/setup', setupLimiter, asyncHandler(async (req, res) => {
    const body = parseWith(z.object({ token: z.string().min(10).max(200), username: usernameSchema, password: z.string().max(200) }), req.body);
    if (adminCount() > 0) throw new AppError(409, 'setup_complete', 'Setup has already been completed.');
    if (!consumeSetupTokenCheck(ctx, body.token)) {
      ctx.audit('setup_failed', { ip: req.ip, metadata: { reason: 'bad_token' } });
      throw new AppError(403, 'invalid_setup_token', 'The setup token is not valid. Find it in the terminal where the app started, or in the data folder (setup-token.txt).');
    }
    const problem = passwordProblems(body.password, body.username);
    if (problem) throw new AppError(400, 'weak_password', problem);
    const hash = await hashPassword(body.password);
    const now = nowIso();
    let adminId = 0;
    ctx.db.transaction(() => {
      if (adminCount() > 0) throw new AppError(409, 'setup_complete', 'Setup has already been completed.');
      adminId = Number(ctx.db.prepare('INSERT INTO admins (username, password_hash, created_at, last_login_at, password_changed_at) VALUES (?,?,?,?,?)').run(body.username, hash, now, now, now).lastInsertRowid);
      kvDelete(ctx.db, 'setup_token_hash');
    })();
    try { fs.unlinkSync(ctx.config.setupTokenPath); } catch { /* already gone */ }
    ctx.audit('setup_completed', { actor: `admin:${body.username}`, ip: req.ip });
    const { csrfToken } = createSession(ctx, req, res, adminId);
    res.status(201).json({ success: true, username: body.username, csrfToken });
  }));

  // ----- one-time onboarding (before the first admin exists) -----
  // The browser submits the answers straight to FormSubmit (AJAX, same tab). This endpoint only records that onboarding is finished,
  // so it is never shown again. It sends nothing anywhere and stores no answers.
  r.post('/onboarding', setupLimiter, (req, res) => {
    const body = parseWith(z.object({ skip: z.boolean().optional(), delivered: z.boolean().optional() }).refine((v) => v.skip || v.delivered, 'Send { "delivered": true } or { "skip": true }.'), req.body ?? {});
    if (onboardingDone()) { res.json({ success: true, alreadyDone: true }); return; }
    kvSet(ctx.db, 'onboarding_done', nowIso());
    ctx.audit(body.skip ? 'onboarding_skipped' : 'onboarding_completed', { ip: req.ip });
    res.status(201).json({ success: true });
  });

  // ----- authentication -----
  r.post('/login', loginLimiter, asyncHandler(async (req, res) => {
    const body = parseWith(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }), req.body);
    const row = ctx.db.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?').get(body.username) as { id: number; username: string; password_hash: string } | undefined;
    const ok = row ? await verifyPassword(body.password, row.password_hash) : (await burnPasswordTime(body.password), false);
    if (!row || !ok) {
      ctx.audit('login_failed', { ip: req.ip, metadata: { username: body.username.slice(0, 64) } });
      throw new AppError(401, 'invalid_credentials', 'Invalid username or password.');
    }
    ctx.db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
    const { csrfToken } = createSession(ctx, req, res, row.id);
    ctx.audit('login_success', { actor: `admin:${row.username}`, ip: req.ip });
    res.json({ success: true, username: row.username, csrfToken });
  }));

  r.post('/logout', (req, res) => {
    if (req.admin) ctx.audit('logout', { actor: actor(req), ip: req.ip });
    destroySession(ctx, req, res);
    res.json({ success: true });
  });

  // ----- everything below needs a session; mutations also need the CSRF token -----
  r.use(requireAdmin, csrfGuard);

  r.post('/change-password', asyncHandler(async (req, res) => {
    const body = parseWith(z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }), req.body);
    const row = ctx.db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(req.admin!.id) as { password_hash: string };
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw new AppError(403, 'wrong_password', 'The current password is incorrect.');
    const problem = passwordProblems(body.newPassword, req.admin!.username);
    if (problem) throw new AppError(400, 'weak_password', problem);
    ctx.db.prepare('UPDATE admins SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(await hashPassword(body.newPassword), nowIso(), req.admin!.id);
    const dropped = invalidateOtherSessions(ctx, req.admin!.id, null); // all sessions, including this one
    ctx.audit('password_changed', { actor: actor(req), ip: req.ip, metadata: { sessionsInvalidated: dropped } });
    const { csrfToken } = createSession(ctx, req, res, req.admin!.id); // rotate into a fresh session
    res.json({ success: true, csrfToken, sessionsInvalidated: dropped });
  }));

  r.post('/sessions/revoke-others', (req, res) => {
    const n = invalidateOtherSessions(ctx, req.admin!.id, req.admin!.sessionHash);
    ctx.audit('sessions_revoked', { actor: actor(req), ip: req.ip, metadata: { count: n } });
    res.json({ success: true, revoked: n });
  });

  // ----- overview -----
  r.get('/overview', asyncHandler(async (_req, res) => {
    const s = ctx.settings();
    const q = (sql: string, ...p: unknown[]) => ctx.db.prepare(sql).get(...p) as Record<string, number>;
    const totals = q(`SELECT COUNT(*) total,
      COALESCE(SUM(status='active'),0) active, COALESCE(SUM(status='trashed'),0) trashed,
      COALESCE(SUM(CASE WHEN status='active' THEN size END),0) activeBytes, COALESCE(SUM(CASE WHEN status='trashed' THEN size END),0) trashedBytes FROM videos WHERE media_type = 'video'`);
    const byType = ctx.db.prepare(`SELECT media_type t, COUNT(*) total, COALESCE(SUM(status='active'),0) active, COALESCE(SUM(status='trashed'),0) trashed,
      COALESCE(SUM(CASE WHEN status='active' THEN size END),0) activeBytes, COALESCE(SUM(CASE WHEN status='trashed' THEN size END),0) trashedBytes FROM videos GROUP BY media_type`).all() as Record<string, number | string>[];
    const media: Record<string, unknown> = { video: null, image: null, file: null };
    for (const row of byType) { const { t, ...rest } = row; media[String(t)] = rest; }
    const today = startOfTodayUtc(s.timeZone).toISOString();
    const uploadsToday = q("SELECT COUNT(*) c FROM audit_events WHERE type IN ('video_uploaded','image_uploaded','file_uploaded') AND created_at >= ?", today).c;
    const recent = ctx.db.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT 6').all() as import('./videos').VideoRow[];
    const events = ctx.db.prepare('SELECT id, type, created_at createdAt, actor, metadata FROM audit_events ORDER BY id DESC LIMIT 8').all() as { metadata: string | null }[];
    const diag = await diagnostics(ctx);
    res.json({
      success: true,
      media,
      totals: { total: totals.total, active: totals.active, trashed: totals.trashed, activeBytes: totals.activeBytes, trashedBytes: totals.trashedBytes, uploadsToday },
      disk: await diskSpace(ctx.config.storageRoot),
      recentUploads: recent.map((v) => toItem(v, s)),
      recentEvents: events.map((e) => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null })),
      health: { api: 'ok', storage: diag.status, messages: diag.messages },
    });
  }));

  // ----- videos -----
  // `mediaType` selects the library (video by default; image | file | all). Same filters as the automation API.
  r.get('/videos', (req, res) => {
    const q = parseWith(mediaQuerySchema, req.query);
    res.json({ success: true, ...listVideos(ctx, toListOpts(q, { defaultStatus: 'active' })) });
  });
  r.get('/videos/:id', (req, res) => res.json({ success: true, item: toItem(requireVideo(ctx, req.params.id), ctx.settings()) }));

  const act = (fn: (id: string) => Promise<import('./videos').BulkResult>) => asyncHandler(async (req, res) => {
    const { ids: list } = parseWith(ids, req.body);
    res.json({ success: true, ...(await bulk(list, fn)) });
  });
  r.post('/videos/trash', (req, res, next) => act((id) => trashVideo(ctx, id, actor(req), req.ip))(req, res, next));
  r.post('/videos/restore', (req, res, next) => act((id) => restoreVideo(ctx, id, actor(req), req.ip))(req, res, next));
  r.post('/videos/delete', (req, res, next) => act((id) => purgeVideo(ctx, id, actor(req), req.ip))(req, res, next));
  r.post('/trash/empty', asyncHandler(async (req, res) => {
    parseWith(z.object({ confirm: z.literal('EMPTY TRASH') }), req.body);
    const out = await bulk(trashedIds(ctx), (id) => purgeVideo(ctx, id, actor(req), req.ip));
    ctx.audit('trash_emptied', { actor: actor(req), ip: req.ip, metadata: { deleted: out.succeeded, failed: out.failed } });
    res.json({ success: true, ...out });
  }));

  // ----- API keys -----
  r.get('/api-keys', (_req, res) => {
    res.json({ success: true, items: listApiKeys(ctx).map((k) => ({ id: k.id, label: k.label, prefix: k.key_prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, status: k.revoked_at ? 'revoked' : 'active' })) });
  });
  r.post('/api-keys', (req, res) => {
    const { label } = parseWith(z.object({ label: z.string().trim().min(1).max(80) }), req.body);
    const { key, row } = createApiKey(ctx, label);
    ctx.audit('api_key_created', { actor: actor(req), ip: req.ip, metadata: { keyId: row.id, label } });
    res.status(201).json({ success: true, key, item: { id: row.id, label: row.label, prefix: row.key_prefix, createdAt: row.created_at, lastUsedAt: null, revokedAt: null, status: 'active' } });
  });
  r.post('/api-keys/:id/revoke', (req, res) => {
    const row = ctx.db.prepare('SELECT id, label, revoked_at FROM api_keys WHERE id = ?').get(req.params.id) as { id: string; label: string; revoked_at: string | null } | undefined;
    if (!row) throw new AppError(404, 'not_found', 'API key not found.');
    if (!row.revoked_at) {
      ctx.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
      ctx.audit('api_key_revoked', { actor: actor(req), ip: req.ip, metadata: { keyId: row.id, label: row.label } });
    }
    res.json({ success: true });
  });

  // ----- settings -----
  r.get('/settings', (_req, res) => res.json({ success: true, settings: ctx.settings() }));
  r.put('/settings', (req, res) => {
    const patch = parseWith(settingsPatchSchema, req.body);
    const before = ctx.settings();
    updateSettings(ctx.db, patch);
    const changed = Object.keys(patch);
    if (changed.length) {
      const meta: Record<string, unknown> = { changed };
      if (patch.publicBaseUrl && patch.publicBaseUrl !== before.publicBaseUrl) { meta.publicBaseUrlFrom = before.publicBaseUrl; meta.publicBaseUrlTo = patch.publicBaseUrl; }
      ctx.audit('settings_changed', { actor: actor(req), ip: req.ip, metadata: meta });
    }
    res.json({ success: true, settings: getSettings(ctx.db, ctx.config.defaultPublicBaseUrl) });
  });
  r.post('/settings/verify-url', asyncHandler(async (_req, res) => {
    // Fetches ONLY "<configured public base URL>/api/v1/health" (admin-triggered, no redirects, 8s timeout).
    const base = normalizeBaseUrl(ctx.settings().publicBaseUrl);
    const started = Date.now();
    try {
      const resp = await fetch(`${base}/api/v1/health`, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      const text = (await resp.text()).slice(0, 2000);
      let isApp = false;
      try { isApp = JSON.parse(text)?.app === 'local-video-host'; } catch { /* not JSON */ }
      const ok = resp.status === 200 && isApp;
      res.json({ success: true, ok, status: resp.status, ms: Date.now() - started, message: ok ? 'The public URL reaches this application.' : resp.status >= 300 && resp.status < 400 ? 'The URL redirects elsewhere; point it directly at this app.' : 'The URL responded, but not with this application\'s health endpoint. Check your tunnel / reverse proxy target.' });
    } catch (e) {
      res.json({ success: true, ok: false, status: null, ms: Date.now() - started, message: `Could not reach the public URL (${(e as Error).name === 'TimeoutError' ? 'timed out' : 'connection failed'}). Make sure your tunnel is running and the URL is correct.` });
    }
  }));

  // ----- logs -----
  r.get('/logs', (req, res) => {
    const qs = parseWith(z.object({ q: z.string().max(200).optional(), type: z.string().max(60).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const where: string[] = []; const p: unknown[] = [];
    if (qs.type) { where.push('type = ?'); p.push(qs.type); }
    if (qs.q) { const like = `%${qs.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`; where.push("(type LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')"); p.push(like, like, like, like); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (ctx.db.prepare(`SELECT COUNT(*) c FROM audit_events ${w}`).get(...p) as { c: number }).c;
    const rows = ctx.db.prepare(`SELECT id, type, created_at createdAt, actor, ip, metadata FROM audit_events ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, qs.pageSize, (qs.page - 1) * qs.pageSize) as { metadata: string | null }[];
    const types = (ctx.db.prepare('SELECT DISTINCT type FROM audit_events ORDER BY type').all() as { type: string }[]).map((t) => t.type);
    res.json({ success: true, items: rows.map((e) => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null })), total, page: qs.page, pageSize: qs.pageSize, totalPages: Math.max(1, Math.ceil(total / qs.pageSize)), types });
  });

  // ----- storage & diagnostics -----
  r.get('/storage', asyncHandler(async (_req, res) => res.json({ success: true, ...(await storageReport(ctx)), orphans: await listOrphans(ctx) })));
  r.post('/storage/cleanup-temp', asyncHandler(async (req, res) => {
    const { olderThanMinutes } = parseWith(z.object({ olderThanMinutes: z.number().int().min(15).max(10080).default(60) }), req.body ?? {});
    const out = await cleanTemp(ctx, olderThanMinutes * 60_000);
    ctx.audit('cleanup_completed', { actor: actor(req), ip: req.ip, metadata: { scope: 'temp', ...out } });
    res.json({ success: true, ...out });
  }));
  r.get('/diagnostics', asyncHandler(async (_req, res) => res.json({ success: true, ...(await diagnostics(ctx)) })));
  // ----- metadata (FFprobe / built-in analysers) -----
  r.get('/metadata/status', asyncHandler(async (_req, res) => {
    res.json({ success: true, tools: await metadataTools(ctx), counts: metadataCounts(ctx), job: { running: ctx.metadata.running, total: ctx.metadata.total, done: ctx.metadata.done } });
  }));
  r.post('/metadata/backfill', (req, res) => {
    const body = parseWith(z.object({ scope: z.enum(['pending', 'failed', 'unavailable', 'all']).default('pending'), mediaType: z.enum(['video', 'image', 'all']).default('all') }), req.body ?? {});
    const statuses = body.scope === 'all' ? ['pending', 'failed', 'unavailable', 'ready'] : body.scope === 'pending' ? ['pending'] : [body.scope];
    const out = startBackfill(ctx, { statuses: statuses as never, mediaType: body.mediaType });
    ctx.audit('metadata_backfill_started', { actor: actor(req), ip: req.ip, metadata: { ...body, queued: out.queued } });
    res.json({ success: true, ...out });
  });
  r.post('/videos/:id/reprocess', asyncHandler(async (req, res) => {
    const row = requireVideo(ctx, req.params.id);
    if (row.media_type === 'file') throw new AppError(400, 'not_applicable', 'Files have no analysable metadata.');
    res.json({ success: true, item: toItem((await extractMetadata(ctx, row.id)) ?? row, ctx.settings()) });
  }));

  r.post('/maintenance/run', asyncHandler(async (_req, res) => {
    const out = await runMaintenance(ctx, 'manual');
    if (!out) throw new AppError(409, 'maintenance_running', 'A cleanup job is already running.');
    res.json({ success: true, result: out });
  }));

  r.use((_req, _res, next) => next(new AppError(404, 'not_found', 'Unknown endpoint.')));
  return r;
}

export { getVideo };
