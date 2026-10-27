import { z } from 'zod';
import type { DB } from './db';
import { AppError } from './errors';
import { isValidTimeZone, nowIso } from './util';

import { VIDEO_EXTS } from './mediaTypes';

export const SUPPORTED_TYPES = VIDEO_EXTS as [string, ...string[]];
export const GIB = 1024 ** 3;

export interface Settings {
  publicBaseUrl: string;
  maxUploadBytes: number;
  allowedTypes: string[];
  fieldName: string;
  uploadRetentionDays: number;
  trashRetentionDays: number;
  storageWarnFreeBytes: number;
  auditRetentionDays: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  timeZone: string;
  timeFormat: '12h' | '24h';
  /** Application-level short/long classification (not a platform rule). */
  shortVideoMaxSeconds: number;
  /** Upper bound for a single metadata analysis run. */
  metadataTimeoutSeconds: number;
}

export function defaultSettings(defaultPublicBaseUrl: string): Settings {
  return {
    publicBaseUrl: defaultPublicBaseUrl,
    maxUploadBytes: 1 * GIB,
    allowedTypes: [...SUPPORTED_TYPES],
    fieldName: 'data',
    uploadRetentionDays: 0,
    trashRetentionDays: 30,
    storageWarnFreeBytes: 5 * GIB,
    auditRetentionDays: 90,
    logLevel: 'info',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    timeFormat: '24h',
    shortVideoMaxSeconds: 60,
    metadataTimeoutSeconds: 60,
  };
}

/** Validate and normalise a public base URL. Only an origin (scheme + host[:port]) is accepted. */
export function normalizeBaseUrl(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new AppError(400, 'invalid_public_base_url', 'Public base URL is not a valid URL (example: https://media.example.com).'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppError(400, 'invalid_public_base_url', 'Public base URL must start with http:// or https://.');
  if (u.username || u.password) throw new AppError(400, 'invalid_public_base_url', 'Public base URL must not contain credentials.');
  if (u.search || u.hash) throw new AppError(400, 'invalid_public_base_url', 'Public base URL must not contain a query string or fragment.');
  if (u.pathname !== '/' && u.pathname !== '') throw new AppError(400, 'invalid_public_base_url', 'Public base URL must be a bare origin without a path (example: https://media.example.com).');
  if (!u.hostname) throw new AppError(400, 'invalid_public_base_url', 'Public base URL needs a host name.');
  return u.origin;
}

const baseUrlSchema = z.string().max(300).transform((v, ctx) => {
  try { return normalizeBaseUrl(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); return z.NEVER; }
});

export const settingsPatchSchema = z.object({
  publicBaseUrl: baseUrlSchema,
  maxUploadBytes: z.number().int().min(1024 * 1024, 'Minimum is 1 MB').max(50 * GIB, 'Maximum is 50 GB'),
  allowedTypes: z.array(z.enum(SUPPORTED_TYPES as [string, ...string[]])).min(1, 'Select at least one type').transform((a) => [...new Set(a)]),
  fieldName: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Use 1-64 letters, digits, "_", "-" or "."'),
  uploadRetentionDays: z.number().int().min(0).max(3650),
  trashRetentionDays: z.number().int().min(0).max(3650),
  storageWarnFreeBytes: z.number().int().min(0).max(10 * 1024 * GIB),
  auditRetentionDays: z.number().int().min(1).max(3650),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  timeZone: z.string().refine(isValidTimeZone, 'Unknown IANA time zone'),
  timeFormat: z.enum(['12h', '24h']),
  shortVideoMaxSeconds: z.number().min(1).max(86_400),
  metadataTimeoutSeconds: z.number().int().min(5).max(600),
}).partial().strict();

export function getSettings(db: DB, defaultPublicBaseUrl: string): Settings {
  const out: Record<string, unknown> = { ...defaultSettings(defaultPublicBaseUrl) };
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  for (const r of rows) {
    if (!(r.key in out)) continue;
    try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
  }
  return out as unknown as Settings;
}

export function updateSettings(db: DB, patch: Partial<Settings>): void {
  const stmt = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  db.transaction(() => { for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v), nowIso()); })();
}
