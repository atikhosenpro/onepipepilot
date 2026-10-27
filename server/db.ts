import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { AppConfig } from './config';
import { migrations } from './migrations';
import { nowIso } from './util';

export type DB = Database.Database;

export function openDatabase(config: AppConfig): DB {
  for (const dir of [config.dataDir, config.storageRoot, ...Object.values(config.dirs)]) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);
  return db;
}

export function runMigrations(db: DB): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const ran: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, nowIso());
    })();
    ran.push(m.version);
  }
  return ran;
}

export function kvGet(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function kvSet(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, nowIso());
}
export function kvDelete(db: DB, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}
