/** Google Drive API access: encrypted credential store, OAuth 2.0 (authorization code + PKCE), token refresh and thin REST wrappers (no extra dependency). */
import crypto from 'node:crypto';
import type { Ctx } from './context';
import { kvDelete, kvGet, kvSet } from './db';
import { AppError } from './errors';
import { loadKey, seal, unseal } from './secretBox';
import { nowIso, randomToken, sha256Hex } from './util';

export const GOOGLE = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/drive/v3',
  scope: 'https://www.googleapis.com/auth/drive.readonly', // read-only: the app can never change or delete anything in Drive
};
const K = { clientId: 'gdrive.client_id', secret: 'gdrive.client_secret', refresh: 'gdrive.refresh_token', access: 'gdrive.access_token', expires: 'gdrive.access_expires',
  account: 'gdrive.account', connectedAt: 'gdrive.connected_at', status: 'gdrive.status', lastCheck: 'gdrive.last_check', pending: 'gdrive.pending.' };

export const DRIVE_FOLDER = 'application/vnd.google-apps.folder';
export const DRIVE_SHORTCUT = 'application/vnd.google-apps.shortcut';
export const WORKSPACE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: 'png' },
};

const key = (ctx: Ctx) => loadKey(ctx.config.dataDir);
const getSealed = (ctx: Ctx, k: string): string | null => { const v = kvGet(ctx.db, k); if (!v) return null; try { return unseal(key(ctx), v); } catch { return null; } };
const setSealed = (ctx: Ctx, k: string, v: string) => kvSet(ctx.db, k, seal(key(ctx), v));
export const redirectUri = (ctx: Ctx) => `${ctx.settings().publicBaseUrl}/api/admin/drive/callback`;

export type DriveStatus = 'not_configured' | 'disconnected' | 'connected' | 'reauthorization_required';
export function driveState(ctx: Ctx) {
  const clientId = kvGet(ctx.db, K.clientId);
  const hasSecret = !!kvGet(ctx.db, K.secret);
  const hasToken = !!kvGet(ctx.db, K.refresh);
  const stored = kvGet(ctx.db, K.status);
  const status: DriveStatus = !clientId || !hasSecret ? 'not_configured' : !hasToken ? 'disconnected' : stored === 'reauthorization_required' ? 'reauthorization_required' : 'connected';
  let account: { email: string | null; name: string | null } | null = null;
  try { const a = kvGet(ctx.db, K.account); account = a ? JSON.parse(a) : null; } catch { /* ignore */ }
  let lastCheck: { at: string; ok: boolean; message: string } | null = null;
  try { const l = kvGet(ctx.db, K.lastCheck); lastCheck = l ? JSON.parse(l) : null; } catch { /* ignore */ }
  return { status, clientId: clientId ?? '', hasSecret, account, connectedAt: kvGet(ctx.db, K.connectedAt), lastCheck, redirectUri: redirectUri(ctx), scope: GOOGLE.scope };
}

function clearTokens(ctx: Ctx) { for (const k of [K.refresh, K.access, K.expires, K.account, K.connectedAt, K.status]) kvDelete(ctx.db, k); }

export function saveConfig(ctx: Ctx, clientId: string, clientSecret?: string) {
  const prev = kvGet(ctx.db, K.clientId);
  if (prev && prev !== clientId) clearTokens(ctx); // tokens belong to the old OAuth client
  kvSet(ctx.db, K.clientId, clientId);
  if (clientSecret) setSealed(ctx, K.secret, clientSecret);
  if (!kvGet(ctx.db, K.secret)) throw new AppError(400, 'validation_error', 'A client secret is required the first time.');
}

// ---------- errors ----------
export class DriveError extends AppError {}
const notConnected = () => new DriveError(409, 'drive_not_connected', 'Google Drive is not connected. An administrator must connect it on the dashboard (Google Drive page).');
const reauth = () => new DriveError(409, 'drive_reauthorization_required', 'Google Drive access has expired or was revoked. An administrator must reconnect Google Drive on the dashboard.');

export async function mapDriveHttpError(res: Response): Promise<DriveError> {
  let reason = '';
  try { const j = JSON.parse((await res.text()).slice(0, 4000)); reason = String(j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? ''); } catch { /* not JSON */ }
  if (res.status === 401) return reauth();
  if (res.status === 404) return new DriveError(404, 'drive_file_not_found', 'The file was not found, or the connected Google account has no access to it. Share the file with that account and try again.');
  if (res.status === 429 || /rateLimit|dailyLimit|quotaExceeded|sharingRateLimit/i.test(reason)) return new DriveError(429, 'drive_quota_exceeded', 'Google Drive API quota or rate limit reached. Wait a while and try again.');
  if (res.status === 403) {
    if (/exportSizeLimit/i.test(reason)) return new DriveError(413, 'drive_export_too_large', 'This Google document is too large for Google to export (10 MB limit).');
    if (/download|notDownloadable/i.test(reason)) return new DriveError(403, 'drive_download_restricted', 'The owner has disabled downloading for this file.');
    return new DriveError(403, 'drive_access_denied', 'The connected Google account is not allowed to read this file.');
  }
  if (res.status === 400) return new DriveError(400, 'drive_bad_request', 'Google Drive rejected the request (the file may not support this operation).');
  return new DriveError(502, 'drive_unavailable', `Google Drive is temporarily unavailable (HTTP ${res.status}). Try again shortly.`);
}

// ---------- tokens ----------
async function tokenRequest(params: Record<string, string>): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  let res: Response;
  try { res = await fetch(GOOGLE.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) }); }
  catch { throw new DriveError(502, 'drive_unavailable', 'Could not reach Google to authorise (network problem). Try again.'); }
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* empty */ }
  return { ok: res.ok, status: res.status, json };
}

async function refreshAccessToken(ctx: Ctx): Promise<string> {
  const clientId = kvGet(ctx.db, K.clientId), secret = getSealed(ctx, K.secret), refresh = getSealed(ctx, K.refresh);
  if (!clientId || !secret || !refresh) throw notConnected();
  const r = await tokenRequest({ client_id: clientId, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' });
  if (!r.ok || typeof r.json.access_token !== 'string') {
    if (r.json.error === 'invalid_grant' || r.status === 400 || r.status === 401) {
      kvSet(ctx.db, K.status, 'reauthorization_required');
      ctx.audit('drive_reauthorization_required', { actor: 'system', metadata: { reason: String(r.json.error ?? r.status) } });
      throw reauth();
    }
    throw new DriveError(502, 'drive_unavailable', 'Google could not refresh the access token right now. Try again shortly.');
  }
  setSealed(ctx, K.access, r.json.access_token);
  kvSet(ctx.db, K.expires, new Date(Date.now() + (Number(r.json.expires_in) || 3600) * 1000).toISOString());
  kvSet(ctx.db, K.status, 'connected');
  return r.json.access_token;
}

/** Returns a valid access token (refreshing when needed). Concurrent callers share one refresh. */
export async function accessToken(ctx: Ctx, forceRefresh = false): Promise<string> {
  if (driveState(ctx).status === 'not_configured' || !kvGet(ctx.db, K.refresh)) throw notConnected();
  if (kvGet(ctx.db, K.status) === 'reauthorization_required' && !forceRefresh) throw reauth();
  const exp = Date.parse(kvGet(ctx.db, K.expires) ?? '');
  const cached = getSealed(ctx, K.access);
  if (!forceRefresh && cached && exp - Date.now() > 60_000) return cached;
  if (!ctx.drive.refreshing) ctx.drive.refreshing = refreshAccessToken(ctx).finally(() => { ctx.drive.refreshing = null; });
  return ctx.drive.refreshing;
}

/** Authorised GET against the Drive API. Retries once after a token refresh on 401, and a few times on 429/5xx. */
export async function driveFetch(ctx: Ctx, url: string, signal?: AbortSignal): Promise<Response> {
  if (!url.startsWith(GOOGLE.api + '/')) throw new Error('Refusing to call a non-Drive URL.'); // never an arbitrary URL
  let token = await accessToken(ctx);
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: signal ?? AbortSignal.timeout(30_000), redirect: 'error' }); }
    catch (e) {
      if (signal?.aborted) throw e;
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
      throw new DriveError(502, 'drive_unavailable', 'Could not reach Google Drive (network problem). Try again.');
    }
    if (res.status === 401 && !refreshed) { refreshed = true; token = await accessToken(ctx, true); continue; }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await res.arrayBuffer().catch(() => undefined); await new Promise((r) => setTimeout(r, 400 * (attempt + 1) ** 2)); continue; }
    return res;
  }
}

// ---------- OAuth flow ----------
export function beginAuth(ctx: Ctx, adminId: number): string {
  const clientId = kvGet(ctx.db, K.clientId);
  if (!clientId || !kvGet(ctx.db, K.secret)) throw new AppError(409, 'drive_not_configured', 'Save the OAuth Client ID and Client Secret first.');
  // drop expired pending authorisations
  const rows = ctx.db.prepare("SELECT key, value FROM kv WHERE key LIKE ?").all(K.pending + '%') as { key: string; value: string }[];
  for (const r of rows) { try { if (JSON.parse(unseal(key(ctx), r.value)).expires < Date.now()) kvDelete(ctx.db, r.key); } catch { kvDelete(ctx.db, r.key); } }
  const state = randomToken(32), verifier = randomToken(48);
  kvSet(ctx.db, K.pending + sha256Hex(state), seal(key(ctx), JSON.stringify({ adminId, verifier, redirectUri: redirectUri(ctx), expires: Date.now() + 10 * 60_000 })));
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(ctx), response_type: 'code', scope: GOOGLE.scope, access_type: 'offline', prompt: 'consent',
    state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  return `${GOOGLE.auth}?${q}`;
}

export async function completeAuth(ctx: Ctx, code: string, state: string): Promise<void> {
  const k = K.pending + sha256Hex(state);
  const raw = kvGet(ctx.db, k);
  kvDelete(ctx.db, k); // single use
  if (!raw) throw new AppError(400, 'invalid_state', 'This authorisation request is unknown or was already used. Start the connection again.');
  let p: { adminId: number; verifier: string; redirectUri: string; expires: number };
  try { p = JSON.parse(unseal(key(ctx), raw)); } catch { throw new AppError(400, 'invalid_state', 'This authorisation request is invalid.'); }
  if (p.expires < Date.now()) throw new AppError(400, 'state_expired', 'The authorisation request expired. Start the connection again.');
  const clientId = kvGet(ctx.db, K.clientId), secret = getSealed(ctx, K.secret);
  if (!clientId || !secret) throw new AppError(409, 'drive_not_configured', 'OAuth credentials are missing.');
  const r = await tokenRequest({ code, client_id: clientId, client_secret: secret, redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier });
  if (!r.ok || typeof r.json.access_token !== 'string') throw new AppError(400, 'oauth_exchange_failed', 'Google rejected the authorisation (check the Client ID, Client Secret and redirect URI).');
  if (typeof r.json.refresh_token !== 'string') throw new AppError(400, 'no_refresh_token', 'Google did not return a refresh token. Remove this app from your Google account permissions (myaccount.google.com/permissions) and connect again.');
  setSealed(ctx, K.refresh, r.json.refresh_token);
  setSealed(ctx, K.access, r.json.access_token);
  kvSet(ctx.db, K.expires, new Date(Date.now() + (Number(r.json.expires_in) || 3600) * 1000).toISOString());
  kvSet(ctx.db, K.status, 'connected');
  kvSet(ctx.db, K.connectedAt, nowIso());
  const about = await getAbout(ctx).catch(() => null);
  kvSet(ctx.db, K.account, JSON.stringify({ email: about?.user?.emailAddress ?? null, name: about?.user?.displayName ?? null }));
  ctx.audit('drive_connected', { actor: `admin#${p.adminId}`, metadata: { account: about?.user?.emailAddress ?? null } });
}

export async function disconnect(ctx: Ctx, forget: boolean, actor: string | null) {
  const refresh = getSealed(ctx, K.refresh);
  if (refresh) { // best-effort revoke at Google; local removal happens regardless
    await fetch(GOOGLE.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
  clearTokens(ctx);
  if (forget) { kvDelete(ctx.db, K.secret); kvDelete(ctx.db, K.clientId); }
  ctx.audit('drive_disconnected', { actor, metadata: { forgotCredentials: forget } });
}

// ---------- API wrappers ----------
export interface DriveFile {
  id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; md5Checksum?: string; trashed?: boolean; webViewLink?: string;
  shortcutDetails?: { targetId: string; targetMimeType: string }; capabilities?: { canDownload?: boolean }; owners?: { displayName?: string }[];
}
export async function getAbout(ctx: Ctx): Promise<{ user?: { emailAddress?: string; displayName?: string }; storageQuota?: { limit?: string; usage?: string } }> {
  const res = await driveFetch(ctx, `${GOOGLE.api}/about?fields=${encodeURIComponent('user(emailAddress,displayName),storageQuota(limit,usage)')}`);
  if (!res.ok) throw await mapDriveHttpError(res);
  return res.json() as Promise<never>;
}

export async function testConnection(ctx: Ctx) {
  try {
    const about = await getAbout(ctx);
    const out = { at: nowIso(), ok: true, message: `Connected as ${about.user?.emailAddress ?? 'unknown account'}` };
    kvSet(ctx.db, K.lastCheck, JSON.stringify(out));
    if (about.user) kvSet(ctx.db, K.account, JSON.stringify({ email: about.user.emailAddress ?? null, name: about.user.displayName ?? null }));
    ctx.audit('drive_connection_test', { actor: 'admin', metadata: { ok: true } });
    return { ...out, account: { email: about.user?.emailAddress ?? null, name: about.user?.displayName ?? null }, storage: about.storageQuota ?? null };
  } catch (e) {
    kvSet(ctx.db, K.lastCheck, JSON.stringify({ at: nowIso(), ok: false, message: (e as Error).message }));
    ctx.audit('drive_connection_test', { actor: 'admin', metadata: { ok: false, code: (e as AppError).code ?? 'error' } });
    throw e;
  }
}

const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,trashed,webViewLink,shortcutDetails(targetId,targetMimeType),capabilities(canDownload),owners(displayName)';
export async function getFileMeta(ctx: Ctx, fileId: string): Promise<DriveFile> {
  const res = await driveFetch(ctx, `${GOOGLE.api}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`);
  if (!res.ok) throw await mapDriveHttpError(res);
  return res.json() as Promise<DriveFile>;
}

const escQ = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export async function listFiles(ctx: Ctx, o: { mode: 'mydrive' | 'shared'; folderId?: string; q?: string; pageToken?: string; pageSize: number }) {
  const parts = ['trashed = false'];
  if (o.q) parts.push(`name contains '${escQ(o.q)}'`);
  else if (o.mode === 'shared') parts.push('sharedWithMe = true');
  else parts.push(`'${o.folderId && o.folderId !== 'root' ? o.folderId : 'root'}' in parents`); // folderId is validated against DRIVE_ID_RE by the caller
  const params = new URLSearchParams({
    q: parts.join(' and '), pageSize: String(o.pageSize), orderBy: 'folder,name_natural', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    fields: `nextPageToken,files(${FILE_FIELDS})`,
  });
  if (o.pageToken) params.set('pageToken', o.pageToken);
  const res = await driveFetch(ctx, `${GOOGLE.api}/files?${params}`);
  if (!res.ok) throw await mapDriveHttpError(res);
  return res.json() as Promise<{ nextPageToken?: string; files: DriveFile[] }>;
}

export function mediaUrl(fileId: string, exportMime?: string): string {
  const id = encodeURIComponent(fileId);
  return exportMime ? `${GOOGLE.api}/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}` : `${GOOGLE.api}/files/${id}?alt=media&supportsAllDrives=true`;
}
