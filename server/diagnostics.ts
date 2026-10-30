import fs from 'node:fs';
import type { Ctx } from './context';
import { lastCleanup, listOrphans } from './maintenance';
import { checkWritable, diskSpace, dirStats } from './storage';
import { metadataCounts, metadataTools } from './metadata';
import { driveState } from './driveClient';

export async function dirReport(ctx: Ctx, name: string, dir: string) {
  const [stats, w] = await Promise.all([dirStats(dir), checkWritable(dir)]);
  return { name, path: dir, exists: stats.exists, writable: w.writable, fileCount: stats.fileCount, totalBytes: stats.totalBytes, error: stats.error ?? w.error ?? null };
}

export async function storageReport(ctx: Ctx) {
  const { config } = ctx;
  const [uploads, trash, temp, logs] = await Promise.all(Object.entries(config.dirs).map(([n, d]) => dirReport(ctx, n, d)));
  let dbBytes = 0;
  for (const f of [config.dbPath, config.dbPath + '-wal', config.dbPath + '-shm']) { try { dbBytes += fs.statSync(f).size; } catch { /* absent */ } }
  const dataDir = await checkWritable(config.dataDir);
  const database = { name: 'database', path: config.dbPath, exists: fs.existsSync(config.dbPath), writable: dataDir.writable, fileCount: 1, totalBytes: dbBytes, error: dataDir.error ?? null };
  const disk = await diskSpace(config.storageRoot);
  return { storageRoot: config.storageRoot, dataDir: config.dataDir, directories: [uploads, trash, temp, database, logs], disk };
}

export async function diagnostics(ctx: Ctx) {
  const settings = ctx.settings();
  const messages: { level: 'warn' | 'error'; text: string }[] = [];
  let database: { ok: boolean; error?: string } = { ok: true };
  try { ctx.db.prepare('SELECT 1').get(); } catch (e) { database = { ok: false, error: (e as Error).message }; messages.push({ level: 'error', text: 'Database is not responding.' }); }
  const storage = await storageReport(ctx);
  for (const d of storage.directories) {
    if (!d.exists) messages.push({ level: 'error', text: `Directory "${d.name}" is missing.` });
    else if (!d.writable) messages.push({ level: 'error', text: `Directory "${d.name}" is not writable.` });
  }
  if (storage.disk && storage.disk.freeBytes < settings.storageWarnFreeBytes) messages.push({ level: 'warn', text: 'Free disk space is below the configured warning threshold.' });
  let publicBase: { value: string; status: 'ok' | 'warn'; note: string };
  try {
    const u = new URL(settings.publicBaseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    publicBase = local
      ? { value: settings.publicBaseUrl, status: 'warn', note: 'Still pointing at localhost: external services (Buffer, n8n cloud) cannot reach these links.' }
      : u.protocol === 'http:'
        ? { value: settings.publicBaseUrl, status: 'warn', note: 'The public base URL uses plain http. Use https for anything exposed to the internet.' }
        : { value: settings.publicBaseUrl, status: 'ok', note: 'Configured.' };
  } catch { publicBase = { value: settings.publicBaseUrl, status: 'warn', note: 'Invalid URL.' }; }
  if (publicBase.status === 'warn') messages.push({ level: 'warn', text: publicBase.note });
  const cleanup = lastCleanup(ctx);
  if (cleanup && !cleanup.ok) messages.push({ level: 'warn', text: 'The last cleanup run reported errors.' });
  if (ctx.config.devMode) messages.push({ level: 'warn', text: 'Running in development mode. Use "npm run build" then "npm run start" before exposing this app to the internet.' });
  const tools = await metadataTools(ctx);
  const counts = metadataCounts(ctx);
  if (!tools.ffprobe.available) messages.push({ level: 'warn', text: 'FFprobe is not installed: only MP4/MOV/M4V/3GP, WebM/MKV and AVI can be analysed. Other video formats are stored without duration/size metadata.' });
  const pending = (counts.video.pending ?? 0) + (counts.image.pending ?? 0);
  if (pending > 0) messages.push({ level: 'warn', text: `${pending} item(s) are waiting for metadata analysis (System page -> Metadata).` });
  const drive = driveState(ctx);
  if (drive.status === 'reauthorization_required') messages.push({ level: 'warn', text: 'Google Drive access has expired or was revoked. Reconnect it on the Google Drive page.' });
  if (drive.lastCheck && !drive.lastCheck.ok) messages.push({ level: 'warn', text: 'The last Google Drive connection test failed. Check the Google Drive page.' });
  const orphans = await listOrphans(ctx);
  if (orphans.missingFiles.length) messages.push({ level: 'error', text: `${orphans.missingFiles.length} video record(s) have no file on disk.` });
  if (orphans.unknownFiles.length) messages.push({ level: 'warn', text: `${orphans.unknownFiles.length} file(s) on disk are not tracked in the database.` });
  const status = messages.some((m) => m.level === 'error') ? 'error' : messages.some((m) => m.level === 'warn') ? 'warn' : 'ok';
  return {
    status, messages, database, storage, publicBase, lastCleanup: cleanup, orphans, metadata: { tools, counts }, drive: { status: drive.status, account: drive.account?.email ?? null, connectedAt: drive.connectedAt, lastCheck: drive.lastCheck },
    app: { version: ctx.config.version, node: process.version, platform: process.platform, uptimeSeconds: Math.round(process.uptime()), mode: ctx.config.devMode ? 'development' : 'production', trustProxy: ctx.config.trustProxy },
  };
}
