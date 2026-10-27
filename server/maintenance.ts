import fs from 'node:fs';
import type { Ctx } from './context';
import { kvGet, kvSet } from './db';
import { cleanTemp } from './storage';
import { bulk, purgeVideo, trashedIds, trashVideo } from './videos';
import { nowIso } from './util';

export interface MaintenanceResult {
  startedAt: string; finishedAt: string; ok: boolean; trigger: 'schedule' | 'manual' | 'startup';
  tempRemoved: number; tempBytes: number; trashPurged: number; uploadsTrashed: number; sessionsExpired: number; auditPruned: number; errors: string[];
}

const DAY = 86_400_000;

export async function runMaintenance(ctx: Ctx, trigger: MaintenanceResult['trigger']): Promise<MaintenanceResult | null> {
  if (ctx.maintenance.running) return null; // never overlap
  ctx.maintenance.running = true;
  const result: MaintenanceResult = { startedAt: nowIso(), finishedAt: '', ok: true, trigger, tempRemoved: 0, tempBytes: 0, trashPurged: 0, uploadsTrashed: 0, sessionsExpired: 0, auditPruned: 0, errors: [] };
  try {
    const s = ctx.settings();
    try {
      const t = await cleanTemp(ctx, 6 * 3600_000);
      result.tempRemoved = t.removed; result.tempBytes = t.bytes;
      if (t.errors) result.errors.push(`${t.errors} temp file(s) could not be removed`);
    } catch (e) { result.errors.push(`temp cleanup: ${(e as Error).message}`); }

    try {
      if (s.trashRetentionDays > 0) {
        const cutoff = new Date(Date.now() - s.trashRetentionDays * DAY).toISOString();
        const r = await bulk(trashedIds(ctx, cutoff), (id) => purgeVideo(ctx, id, 'system'));
        result.trashPurged = r.succeeded;
        if (r.failed) result.errors.push(`${r.failed} trashed video(s) could not be permanently deleted`);
      }
    } catch (e) { result.errors.push(`trash retention: ${(e as Error).message}`); }

    try {
      // Upload retention only moves videos to the trash; it never permanently deletes active videos.
      if (s.uploadRetentionDays > 0) {
        const cutoff = new Date(Date.now() - s.uploadRetentionDays * DAY).toISOString();
        const ids = (ctx.db.prepare("SELECT id FROM videos WHERE status = 'active' AND created_at <= ?").all(cutoff) as { id: string }[]).map((r) => r.id);
        const r = await bulk(ids, (id) => trashVideo(ctx, id, 'system'));
        result.uploadsTrashed = r.succeeded;
        if (r.failed) result.errors.push(`${r.failed} expired video(s) could not be moved to trash`);
      }
    } catch (e) { result.errors.push(`upload retention: ${(e as Error).message}`); }

    try {
      result.sessionsExpired = ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()).changes;
      result.auditPruned = ctx.db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(new Date(Date.now() - s.auditRetentionDays * DAY).toISOString()).changes;
    } catch (e) { result.errors.push(`database housekeeping: ${(e as Error).message}`); }
  } finally {
    result.ok = result.errors.length === 0;
    result.finishedAt = nowIso();
    kvSet(ctx.db, 'last_cleanup', JSON.stringify(result));
    ctx.audit(result.ok ? 'cleanup_completed' : 'cleanup_failed', { actor: trigger === 'manual' ? 'admin' : 'system', metadata: { ...result } });
    ctx.maintenance.running = false;
  }
  return result;
}

export function lastCleanup(ctx: Ctx): MaintenanceResult | null {
  const raw = kvGet(ctx.db, 'last_cleanup');
  try { return raw ? (JSON.parse(raw) as MaintenanceResult) : null; } catch { return null; }
}

export function startScheduler(ctx: Ctx): void {
  const run = (t: MaintenanceResult['trigger']) => { runMaintenance(ctx, t).catch((e) => ctx.log.error('Maintenance crashed', { error: (e as Error).message })); };
  const first = setTimeout(() => run('startup'), 10_000);
  const every = setInterval(() => run('schedule'), 30 * 60_000);
  first.unref(); every.unref();
  ctx.timers.push(first, every);
}

export async function listOrphans(ctx: Ctx): Promise<{ missingFiles: string[]; unknownFiles: string[] }> {
  const rows = ctx.db.prepare('SELECT id, storage_name, status FROM videos').all() as { id: string; storage_name: string; status: string }[];
  const known = { uploads: new Set<string>(), trash: new Set<string>() };
  const missingFiles: string[] = [];
  const list = async (dir: string) => { try { return new Set(await fs.promises.readdir(dir)); } catch { return new Set<string>(); } };
  const [up, tr] = await Promise.all([list(ctx.config.dirs.uploads), list(ctx.config.dirs.trash)]);
  for (const r of rows) {
    (r.status === 'active' ? known.uploads : known.trash).add(r.storage_name);
    if (!(r.status === 'active' ? up : tr).has(r.storage_name)) missingFiles.push(r.id);
  }
  const unknownFiles = [...[...up].filter((n) => !known.uploads.has(n) && !n.startsWith('.probe-')).map((n) => `uploads/${n}`), ...[...tr].filter((n) => !known.trash.has(n) && !n.startsWith('.probe-')).map((n) => `trash/${n}`)];
  return { missingFiles, unknownFiles };
}
