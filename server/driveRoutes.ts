/** Dashboard-facing Google Drive routes (mounted inside the admin router). Secrets never leave the server. */
import type { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from './context';
import { DRIVE_FOLDER, DRIVE_SHORTCUT, WORKSPACE_EXPORTS, beginAuth, completeAuth, disconnect, driveState, getFileMeta, listFiles, saveConfig, testConnection, type DriveFile } from './driveClient';
import { DRIVE_ID_RE } from './driveUrl';
import { libraryFor, newJob, runImport } from './driveImport';
import { AppError, asyncHandler, parseWith } from './errors';
import { toItem, type VideoRow } from './videos';
import { formatBytes } from './util';

const idSchema = z.string().regex(DRIVE_ID_RE, 'Not a valid Google Drive ID');

/** Google redirects the browser here after consent. Cookies are SameSite=Strict (not sent on this cross-site hop), so this route is protected by the one-time, server-side `state` instead. */
export function driveCallback(r: Router, ctx: Ctx) {
  r.get('/drive/callback', asyncHandler(async (req, res) => {
    const done = (result: 'connected' | 'denied' | 'failed', reason = '') => {
      const url = `/drive?result=${result}${reason ? `&reason=${reason.replace(/[^a-z_]/g, '')}` : ''}`;
      // A meta refresh is a same-site navigation started by our own page, so the session cookie is sent again.
      res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"><title>Google Drive</title></head><body><p>Returning to the dashboard... <a href="${url}">Continue</a></p></body></html>`);
    };
    const { code, state, error } = req.query;
    if (typeof error === 'string') { ctx.audit('drive_connect_failed', { ip: req.ip, metadata: { reason: 'denied_by_user' } }); return done('denied'); }
    if (typeof code !== 'string' || typeof state !== 'string' || code.length > 2048 || state.length > 256) return done('failed', 'invalid_request');
    try { await completeAuth(ctx, code, state); done('connected'); }
    catch (e) { const c = e instanceof AppError ? e.code : 'error'; ctx.audit('drive_connect_failed', { ip: req.ip, metadata: { code: c } }); done('failed', c); }
  }));
}

function describe(f: DriveFile) {
  const target = f.mimeType === DRIVE_SHORTCUT && f.shortcutDetails ? { id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType } : { id: f.id, mimeType: f.mimeType };
  const exp = WORKSPACE_EXPORTS[target.mimeType];
  const m = target.mimeType;
  const kind = m === DRIVE_FOLDER ? 'folder' : exp ? 'document' : m.startsWith('application/vnd.google-apps.') ? 'unsupported' : m.startsWith('video/') ? 'video' : m.startsWith('image/') ? 'image' : m.startsWith('audio/') ? 'audio' : /pdf|msword|officedocument|text\//.test(m) ? 'document' : 'other';
  const importable = kind !== 'folder' && kind !== 'unsupported';
  const size = f.size != null ? Number(f.size) : null;
  return {
    id: target.id, name: f.name, mimeType: m, kind, isShortcut: f.mimeType === DRIVE_SHORTCUT, size, sizeFormatted: size != null ? formatBytes(size) : null, modifiedTime: f.modifiedTime ?? null,
    importable, library: importable ? (exp ? (exp.mime.startsWith('image/') ? 'image' : 'file') : libraryFor({ mimeType: m, name: f.name })) : null,
    webViewLink: f.webViewLink ?? null, owner: f.owners?.[0]?.displayName ?? null, exportsAs: exp?.ext ?? null,
  };
}

export function driveAdmin(r: Router, ctx: Ctx, actor: (req: Express.Request) => string | null) {
  r.get('/drive/status', (_req, res) => res.json({ success: true, ...driveState(ctx), importsRunning: [...ctx.drive.jobs.values()].filter((j) => j.state === 'running').length }));

  r.put('/drive/config', (req, res) => {
    const b = parseWith(z.object({ clientId: z.string().trim().min(10).max(200), clientSecret: z.string().trim().min(8).max(200).optional() }), req.body);
    saveConfig(ctx, b.clientId, b.clientSecret || undefined);
    ctx.audit('drive_config_saved', { actor: actor(req), ip: req.ip, metadata: { secretChanged: !!b.clientSecret } }); // values are never logged
    res.json({ success: true, ...driveState(ctx) });
  });

  r.post('/drive/connect', (req, res) => {
    const authUrl = beginAuth(ctx, req.admin!.id);
    ctx.audit('drive_connect_started', { actor: actor(req), ip: req.ip });
    res.json({ success: true, authUrl });
  });

  r.post('/drive/test', asyncHandler(async (_req, res) => res.json({ success: true, ...(await testConnection(ctx)) })));

  r.post('/drive/disconnect', asyncHandler(async (req, res) => {
    const b = parseWith(z.object({ forget: z.boolean().optional() }), req.body ?? {});
    await disconnect(ctx, !!b.forget, actor(req));
    res.json({ success: true, ...driveState(ctx) });
  }));

  r.get('/drive/files', asyncHandler(async (req, res) => {
    const q = parseWith(z.object({
      mode: z.enum(['mydrive', 'shared']).default('mydrive'), folderId: z.union([z.literal('root'), idSchema]).optional(),
      q: z.string().trim().max(100).optional(), pageToken: z.string().max(2000).regex(/^[\w\-+=/.~%]*$/).optional(), pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }), req.query);
    const out = await listFiles(ctx, { mode: q.mode, folderId: q.folderId, q: q.q || undefined, pageToken: q.pageToken || undefined, pageSize: q.pageSize });
    res.json({ success: true, items: out.files.map(describe), nextPageToken: out.nextPageToken ?? null });
  }));

  r.get('/drive/files/:id', asyncHandler(async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    const meta = await getFileMeta(ctx, id);
    const info = describe(meta);
    const imported = ctx.db.prepare("SELECT * FROM videos WHERE source_type = 'gdrive' AND source_id = ? AND status = 'active' ORDER BY created_at DESC").all(info.id) as VideoRow[];
    res.json({ success: true, file: { ...info, md5Checksum: meta.md5Checksum ?? null, canDownload: meta.capabilities?.canDownload !== false }, alreadyImported: imported.map((v) => { const i = toItem(v, ctx.settings()); return { id: v.id, mediaType: v.media_type, publicUrl: i.publicUrl }; }) });
  }));

  r.post('/drive/import', (req, res) => {
    const b = parseWith(z.object({ source: z.string().trim().min(10).max(2048), library: z.enum(['auto', 'video', 'image', 'file']).default('auto') }), req.body);
    const job = newJob(ctx, 'dashboard');
    runImport(ctx, { source: b.source, library: b.library, keyId: null, actor: actor(req), ip: req.ip ?? null, origin: 'dashboard' }, job).catch(() => undefined); // result lives on the job
    res.status(202).json({ success: true, jobId: job.id });
  });

  r.get('/drive/imports', (_req, res) => res.json({ success: true, items: [...ctx.drive.jobs.values()].reverse() }));
}
