import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, formatDate } from '../api';
import { useApp } from '../App';
import { Badge, ErrorBox, Notice, PageHeader, Spinner, useToast } from '../ui';

interface MetaStatus {
  tools: { ffprobe: { available: boolean; path: string; version: string | null }; builtinParser: { videoFormats: string[]; imageFormats: string[] } };
  counts: Record<string, Record<string, number>>; job: { running: boolean; total: number; done: number };
}
interface Diag {
  status: 'ok' | 'warn' | 'error'; messages: { level: 'warn' | 'error'; text: string }[]; database: { ok: boolean; error?: string };
  storage: { directories: { name: string; path: string; exists: boolean; writable: boolean }[]; disk: { freeBytes: number; totalBytes: number } | null };
  publicBase: { value: string; status: 'ok' | 'warn'; note: string };
  lastCleanup: null | { startedAt: string; finishedAt: string; ok: boolean; trigger: string; tempRemoved: number; trashPurged: number; uploadsTrashed: number; errors: string[] };
  app: { version: string; node: string; platform: string; uptimeSeconds: number; mode: string; trustProxy: unknown };
}

export default function System() {
  const { settings } = useApp();
  const toast = useToast();
  const [d, setD] = useState<Diag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const loadMeta = useCallback(() => { api<MetaStatus>('/metadata/status').then(setMeta).catch(() => undefined); }, []);
  const load = useCallback(() => { api<Diag>('/diagnostics').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)); loadMeta(); }, [loadMeta]);
  useEffect(() => { if (!meta?.job.running) return; const t = setInterval(loadMeta, 1500); return () => clearInterval(t); }, [meta?.job.running, loadMeta]);
  const backfill = async (scope: 'pending' | 'failed' | 'unavailable' | 'all') => {
    try { const r = await api<{ started: boolean; queued: number; running: boolean }>('/metadata/backfill', { method: 'POST', body: { scope, mediaType: 'all' } }); toast(r.started ? 'success' : 'info', r.started ? `Analysing ${r.queued} item(s) in the background.` : r.running ? 'An analysis job is already running.' : 'Nothing to analyse for that selection.'); }
    catch (e) { toast('error', (e as Error).message); } finally { loadMeta(); }
  };
  useEffect(load, [load]);
  const run = async () => { setBusy(true); try { const r = await api<{ result: { ok: boolean; errors: string[] } }>('/maintenance/run', { method: 'POST' }); toast(r.result.ok ? 'success' : 'error', r.result.ok ? 'Cleanup finished.' : `Cleanup finished with errors: ${r.result.errors.join('; ')}`); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); load(); } };
  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!d) return <Spinner />;
  const row = (k: string, v: React.ReactNode) => <div className="flex items-center justify-between gap-4 py-2.5 text-sm"><span className="text-ink-500">{k}</span><span className="text-right">{v}</span></div>;
  const tone = d.status === 'ok' ? 'ok' : d.status === 'warn' ? 'warn' : 'error';
  return (
    <>
      <PageHeader title="System diagnostics" subtitle="Checks run live every time you open this page." actions={<><button className="btn-secondary" onClick={load}>Refresh</button><button className="btn-primary" onClick={run} disabled={busy}>Run cleanup now</button></>} />
      <div className="mb-5 flex items-center gap-3"><span className="text-sm text-ink-600">Overall status</span><Badge tone={tone}>{d.status === 'ok' ? 'All good' : d.status === 'warn' ? 'Warnings' : 'Problems found'}</Badge></div>
      {d.messages.length > 0 && <div className="mb-6 space-y-2">{d.messages.map((m, i) => <Notice key={i} tone="warn">{m.text}</Notice>)}</div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card divide-y divide-ink-100 px-5 py-2">
          <h2 className="py-3 font-display text-sm font-semibold">Application</h2>
          {row('Version', d.app.version)}{row('Mode', <Badge tone={d.app.mode === 'production' ? 'ok' : 'warn'}>{d.app.mode}</Badge>)}{row('Node.js', d.app.node)}{row('Platform', d.app.platform)}
          {row('Uptime', `${Math.floor(d.app.uptimeSeconds / 3600)}h ${Math.floor((d.app.uptimeSeconds % 3600) / 60)}m`)}{row('Trusted proxy hops', String(d.app.trustProxy))}
        </section>
        <section className="card divide-y divide-ink-100 px-5 py-2">
          <h2 className="py-3 font-display text-sm font-semibold">Components</h2>
          {row('Database', <Badge tone={d.database.ok ? 'ok' : 'error'}>{d.database.ok ? 'OK' : 'Error'}</Badge>)}
          {d.storage.directories.filter((x) => ['uploads', 'trash', 'temp'].includes(x.name)).map((x) => row(`${x.name[0].toUpperCase()}${x.name.slice(1)} directory`, <Badge tone={x.exists && x.writable ? 'ok' : 'error'}>{!x.exists ? 'Missing' : x.writable ? 'Writable' : 'Read-only'}</Badge>))}
          {row('Disk space', d.storage.disk ? `${formatBytes(d.storage.disk.freeBytes)} free of ${formatBytes(d.storage.disk.totalBytes)}` : 'Not reported')}
          {row('Public base URL', <span className="inline-flex items-center gap-2"><span className="font-mono text-xs">{d.publicBase.value}</span><Badge tone={d.publicBase.status}>{d.publicBase.status === 'ok' ? 'Configured' : 'Check'}</Badge></span>)}
        </section>
        {meta && (
          <section className="card px-5 py-4 lg:col-span-2">
            <h2 className="mb-3 font-display text-sm font-semibold">Media metadata</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2"><span className="text-ink-500">FFprobe</span>{meta.tools.ffprobe.available ? <Badge tone="ok">Installed</Badge> : <Badge tone="warn">Not found</Badge>}</div>
                <p className="text-xs text-ink-600">{meta.tools.ffprobe.available ? meta.tools.ffprobe.version : <>Without FFprobe the built-in reader analyses {meta.tools.builtinParser.videoFormats.join(', ')} videos and common images. Other video formats (MPEG, WMV, FLV, TS, MTS) are stored with metadata marked unavailable. Install FFmpeg (it includes FFprobe) and add it to PATH, or set <span className="font-mono">FFPROBE_PATH</span> in <span className="font-mono">.env</span>, restart, then use "Retry unavailable".</>}</p>
              </div>
              <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-ink-500"><th className="py-1 pr-3">Library</th>{['ready', 'pending', 'unavailable', 'failed'].map((k) => <th key={k} className="py-1 pr-3 capitalize">{k}</th>)}</tr></thead>
                <tbody>{(['video', 'image'] as const).map((t) => <tr key={t} className="border-t border-ink-100"><td className="py-1.5 pr-3 font-medium capitalize">{t}s</td>{['ready', 'pending', 'unavailable', 'failed'].map((k) => <td key={k} className="py-1.5 pr-3 tabular-nums">{meta.counts[t]?.[k] ?? 0}</td>)}</tr>)}</tbody></table></div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button className="btn-primary btn-sm" onClick={() => backfill('pending')} disabled={meta.job.running}>Analyse pending files</button>
              <button className="btn-secondary btn-sm" onClick={() => backfill('unavailable')} disabled={meta.job.running}>Retry unavailable</button>
              <button className="btn-secondary btn-sm" onClick={() => backfill('failed')} disabled={meta.job.running}>Retry failed</button>
              <button className="btn-secondary btn-sm" onClick={() => backfill('all')} disabled={meta.job.running}>Re-analyse everything</button>
              {meta.job.running && <span className="text-xs text-ink-600">Working: {meta.job.done} of {meta.job.total}</span>}
            </div>
            <p className="mt-2 text-xs text-ink-500">Analysis only reads files. It never modifies, moves or deletes them, and runs one file at a time in the background.</p>
          </section>
        )}
        <section className="card px-5 py-4 lg:col-span-2">
          <h2 className="mb-2 font-display text-sm font-semibold">Last cleanup</h2>
          {!d.lastCleanup ? <p className="text-sm text-ink-500">No cleanup has run yet. It runs automatically every 30 minutes.</p> : (
            <div className="space-y-2 text-sm"><div className="flex flex-wrap items-center gap-3"><Badge tone={d.lastCleanup.ok ? 'ok' : 'error'}>{d.lastCleanup.ok ? 'Succeeded' : 'Had errors'}</Badge><span className="text-ink-600">{formatDate(d.lastCleanup.finishedAt, settings)} ({d.lastCleanup.trigger})</span></div>
              <p className="text-ink-600">Temp files removed: {d.lastCleanup.tempRemoved}. Trash purged: {d.lastCleanup.trashPurged}. Expired uploads moved to trash: {d.lastCleanup.uploadsTrashed}.</p>
              {d.lastCleanup.errors.length > 0 && <ul className="list-inside list-disc text-red-700">{d.lastCleanup.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}</div>)}
        </section>
      </div>
    </>
  );
}
