import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import type { Ctx } from './context';
import { kvDelete, kvGet, kvSet } from './db';
import { AppError } from './errors';
import { nowIso, randomToken, safeEqual, sha256Hex } from './util';

export const SESSION_COOKIE = 'lvh_sid';
const SESSION_ABSOLUTE_MS = 7 * 24 * 3600_000;
const SESSION_IDLE_MS = 8 * 3600_000;

// ---------- passwords (scrypt, from node:crypto) ----------
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
const scrypt = (pw: string, salt: Buffer, keylen = SCRYPT.keylen, N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p) =>
  new Promise<Buffer>((res, rej) => crypto.scrypt(pw, salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, Number(N), Number(r), Number(p));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

export async function burnPasswordTime(pw: string): Promise<void> { await verifyPassword(pw, await DUMMY_HASH); }

export const usernameSchema = z.string().regex(/^[A-Za-z0-9._-]{3,32}$/, 'Username must be 3-32 characters: letters, digits, ".", "_" or "-"');
export function passwordProblems(pw: string, username?: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain at least one letter and one digit.';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username.';
  if (/^(.)\1+$/.test(pw) || /password|12345678|qwertyuiop/i.test(pw)) return 'Password is too easy to guess.';
  return null;
}

// ---------- first-run setup token ----------
export function ensureSetupToken(ctx: Ctx): void {
  const { db, config } = ctx;
  const adminCount = (db.prepare('SELECT COUNT(*) c FROM admins').get() as { c: number }).c;
  if (adminCount > 0) {
    kvDelete(db, 'setup_token_hash');
    try { fs.unlinkSync(config.setupTokenPath); } catch { /* none */ }
    return;
  }
  if (kvGet(db, 'setup_token_hash') && fs.existsSync(config.setupTokenPath)) {
    ctx.log.info(`First-run setup is pending. The setup token is stored in: ${config.setupTokenPath}`);
    return;
  }
  const token = randomToken(32);
  kvSet(db, 'setup_token_hash', sha256Hex(token));
  fs.writeFileSync(config.setupTokenPath, token + '\n', { mode: 0o600 });
  if (config.printSetupToken) {
    const bar = '='.repeat(64);
    console.log(`\n${bar}\n  FIRST-RUN SETUP TOKEN (shown once; also saved to ${config.setupTokenPath})\n\n  ${token}\n\n  Open the dashboard and enter this token to create the admin account.\n${bar}\n`);
  }
}

export function consumeSetupTokenCheck(ctx: Ctx, token: string): boolean {
  const stored = kvGet(ctx.db, 'setup_token_hash');
  return !!stored && safeEqual(stored, sha256Hex(token.trim()));
}

// ---------- sessions ----------
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieOptions(ctx: Ctx, req: Request) {
  const secure = ctx.config.cookieSecure === 'auto' ? req.secure : ctx.config.cookieSecure;
  return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/' };
}

export function createSession(ctx: Ctx, req: Request, res: Response, adminId: number): { csrfToken: string } {
  // Rotation: drop any session the browser already had before issuing a fresh identifier.
  const old = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (old) ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(old));
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = Date.now();
  ctx.db.prepare('INSERT INTO sessions (id_hash, admin_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)')
    .run(sha256Hex(token), adminId, csrfToken, nowIso(), nowIso(), new Date(now + SESSION_ABSOLUTE_MS).toISOString(), req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 200));
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(ctx, req), expires: new Date(now + SESSION_ABSOLUTE_MS) });
  return { csrfToken };
}

export function destroySession(ctx: Ctx, req: Request, res: Response): void {
  const tok = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (tok) ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(tok));
  res.clearCookie(SESSION_COOKIE, cookieOptions(ctx, req));
}

/** Loads req.admin when a valid session cookie is present (does not reject). */
export function sessionLoader(ctx: Ctx): RequestHandler {
  return (req, _res, next) => {
    const tok = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (tok) {
      const hash = sha256Hex(tok);
      const row = ctx.db.prepare(`SELECT s.csrf_token, s.last_seen_at, s.expires_at, a.id, a.username
        FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id_hash = ?`).get(hash) as
        { csrf_token: string; last_seen_at: string; expires_at: string; id: number; username: string } | undefined;
      if (row) {
        const now = Date.now();
        if (Date.parse(row.expires_at) < now || Date.parse(row.last_seen_at) + SESSION_IDLE_MS < now) {
          ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash);
        } else {
          if (now - Date.parse(row.last_seen_at) > 60_000) ctx.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(nowIso(), hash);
          req.admin = { id: row.id, username: row.username, sessionHash: hash, csrfToken: row.csrf_token };
        }
      }
    }
    next();
  };
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.admin) return next(new AppError(401, 'unauthorized', 'Sign in required.'));
  next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origin / fetch-metadata check for every state-changing admin request. */
export function originGuard(ctx: Ctx): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.headers['sec-fetch-site'] === 'cross-site') return next(new AppError(403, 'bad_origin', 'Cross-site requests are not allowed.'));
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let ok: boolean;
      try {
        const o = new URL(origin);
        const publicOrigin = new URL(ctx.settings().publicBaseUrl).origin;
        ok = o.host === req.headers.host || o.origin === publicOrigin;
      } catch { ok = false; }
      if (!ok) return next(new AppError(403, 'bad_origin', 'Request origin is not allowed.'));
    } else if (origin === 'null') {
      return next(new AppError(403, 'bad_origin', 'Request origin is not allowed.'));
    }
    next();
  };
}

export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const sent = req.headers['x-csrf-token'];
  if (!req.admin || typeof sent !== 'string' || !safeEqual(sent, req.admin.csrfToken)) {
    return next(new AppError(403, 'csrf_failed', 'Missing or invalid CSRF token.'));
  }
  next();
};

export function invalidateOtherSessions(ctx: Ctx, adminId: number, keepHash: string | null): number {
  return ctx.db.prepare('DELETE FROM sessions WHERE admin_id = ? AND id_hash != ?').run(adminId, keepHash ?? '').changes;
}

// ---------- API keys ----------
export interface ApiKeyRow { id: string; label: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export function createApiKey(ctx: Ctx, label: string): { row: ApiKeyRow; key: string } {
  const id = crypto.randomBytes(6).toString('hex');
  const key = `lvh_${id}_${randomToken(32)}`;
  const createdAt = nowIso();
  const prefix = `lvh_${id}`;
  ctx.db.prepare('INSERT INTO api_keys (id, label, key_prefix, key_hash, created_at) VALUES (?,?,?,?,?)').run(id, label, prefix, sha256Hex(key), createdAt);
  return { key, row: { id, label, key_prefix: prefix, created_at: createdAt, last_used_at: null, revoked_at: null } };
}

export function listApiKeys(ctx: Ctx): ApiKeyRow[] {
  return ctx.db.prepare('SELECT id, label, key_prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC').all() as ApiKeyRow[];
}

export function bearerAuth(ctx: Ctx): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return next(new AppError(401, 'missing_api_key', 'Send your API key as "Authorization: Bearer YOUR_API_KEY".'));
    const row = ctx.db.prepare('SELECT id, label, revoked_at, last_used_at FROM api_keys WHERE key_hash = ?').get(sha256Hex(m[1])) as
      { id: string; label: string; revoked_at: string | null; last_used_at: string | null } | undefined;
    if (!row || row.revoked_at) {
      ctx.audit('api_auth_failed', { ip: req.ip, metadata: { reason: row ? 'revoked_key' : 'unknown_key', keyId: row?.id ?? null, path: req.path } });
      return next(new AppError(401, row ? 'revoked_api_key' : 'invalid_api_key', row ? 'This API key has been revoked.' : 'The API key is not valid.'));
    }
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 30_000) {
      ctx.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
    }
    req.apiKey = { id: row.id, label: row.label };
    next();
  };
}
