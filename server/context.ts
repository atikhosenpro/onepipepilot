import type { AppConfig } from './config';
import { openDatabase, type DB } from './db';
import { createLogger, type Logger } from './logger';
import { getSettings, type Settings } from './settings';
import { nowIso, } from './util';
import { redact } from './logger';

export interface Ctx {
  config: AppConfig;
  db: DB;
  log: Logger;
  settings(): Settings;
  audit(type: string, info?: { actor?: string | null; ip?: string | null; metadata?: Record<string, unknown> }): void;
  activeTemps: Set<string>;
  maintenance: { running: boolean };
  timers: NodeJS.Timeout[];
  /** Progress of the background metadata job (backfill / reprocess). */
  metadata: { running: boolean; total: number; done: number; promise: Promise<void> | null };
  /** Google Drive runtime state (in-memory only; credentials live encrypted in the database). */
  drive: DriveRuntime;
}

export interface ImportJob {
  id: string; origin: 'api' | 'dashboard'; state: 'queued' | 'running' | 'done' | 'failed'; fileId: string | null; name: string | null; library: string | null;
  bytes: number; total: number | null; startedAt: string; finishedAt: string | null; duplicate: boolean;
  error: { code: string; message: string } | null; itemId: string | null; publicUrl: string | null;
}
export interface DriveRuntime { jobs: Map<string, ImportJob>; inflight: Map<string, Promise<unknown>>; active: number; waiters: (() => void)[]; refreshing: Promise<string> | null }

export function createContext(config: AppConfig, opts: { silent?: boolean } = {}): Ctx {
  const db = openDatabase(config);
  const settings = () => getSettings(db, config.defaultPublicBaseUrl);
  const log = createLogger(config.dirs.logs, () => settings().logLevel, opts);
  const ctx: Ctx = {
    config, db, log, settings,
    activeTemps: new Set(),
    maintenance: { running: false },
    timers: [],
    metadata: { running: false, total: 0, done: 0, promise: null },
    drive: { jobs: new Map(), inflight: new Map(), active: 0, waiters: [], refreshing: null },
    audit(type, info = {}) {
      try {
        db.prepare('INSERT INTO audit_events (type, created_at, actor, ip, metadata) VALUES (?, ?, ?, ?, ?)')
          .run(type, nowIso(), info.actor ?? null, info.ip ?? null, info.metadata ? JSON.stringify(redact(info.metadata)) : null);
      } catch (e) { log.error('Failed to write audit event', { type, error: (e as Error).message }); }
    },
  };
  return ctx;
}
