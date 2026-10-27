import { useCallback, useEffect, useState } from 'react';
import { Check, HardDrive, X } from 'lucide-react';
import { api, formatBytes } from '../api';
import { Badge, ConfirmDialog, ErrorBox, Notice, PageHeader, Spinner, useToast } from '../ui';

interface Dir { name: string; path: string; exists: boolean; writable: boolean; fileCount: number; totalBytes: number; error: string | null }
interface Report { storageRoot: string; dataDir: string; directories: Dir[]; disk: { freeBytes: number; totalBytes: number } | null; orphans: { missingFiles: string[]; unknownFiles: string[] } }
const DESC: Record<string, string> = { uploads: 'Active videos served at public URLs', trash: 'Trashed videos (no public URL)', temp: 'In-progress and abandoned uploads', database: 'SQLite metadata, settings, key hashes, audit log', logs: 'Application log files' };

export default function Storage() {
  const toast = useToast();
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => { api<Report & { success: boolean }>('/storage').then((d) => { setR(d); setError(null); }).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  const cleanup = async () => {
    setBusy(true);
    try { const x = await api<{ removed: number; bytes: number; errors: number }>('/storage/cleanup-temp', { method: 'POST', body: { olderThanMinutes: 60 } }); toast(x.errors ? 'error' : 'success', `Removed ${x.removed} stale temp file(s) (${formatBytes(x.bytes)})${x.errors ? `, ${x.errors} failed` : ''}.`); }
    catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); load(); }
  };
  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!r) return <Spinner />;
  return (
    <>
      <PageHeader title="Storage" subtitle="Exact folders used by the app, with live sizes and write checks." actions={<><button className="btn-secondary" onClick={load}>Re-check</button><button className="btn-primary" onClick={() => setConfirm(true)} disabled={busy}>Clean up temp files</button></>} />
      <div className="mb-5"><Notice>Videos, images and files all live in the <span className="font-mono">uploads</span> folder under random IDs (the trash folder holds trashed items of every library). The three libraries are separated in the database, not by folder, so existing videos never had to move.</Notice></div>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <div className="card p-4 sm:col-span-2"><div className="text-xs font-medium text-ink-500">Storage root</div><div className="mt-1 break-all font-mono text-sm">{r.storageRoot}</div><div className="mt-3 text-xs font-medium text-ink-500">Data folder (database, setup token)</div><div className="mt-1 break-all font-mono text-sm">{r.dataDir}</div></div>
        <div className="card p-4"><div className="text-xs font-medium text-ink-500">Disk free</div><div className="mt-1 font-display text-2xl font-semibold">{r.disk ? formatBytes(r.disk.freeBytes) : 'Unknown'}</div>{r.disk && <div className="text-xs text-ink-500">of {formatBytes(r.disk.totalBytes)}</div>}</div>
      </div>
      <div className="card divide-y divide-ink-100">
        {r.directories.map((d) => (
          <div key={d.name} className="flex flex-wrap items-center gap-4 p-4">
            <HardDrive className="h-5 w-5 shrink-0 text-ink-400" />
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="font-medium capitalize">{d.name}</span><span className="text-xs text-ink-500">{DESC[d.name]}</span></div><div className="mt-0.5 break-all font-mono text-xs text-ink-600">{d.path}</div>{d.error && <div className="mt-1 text-xs text-red-700">Error: {d.error}</div>}</div>
            <div className="text-right text-sm tabular-nums"><div>{d.fileCount.toLocaleString()} file{d.fileCount === 1 ? '' : 's'}</div><div className="text-xs text-ink-500">{formatBytes(d.totalBytes)}</div></div>
            <div className="flex gap-1.5"><Badge tone={d.exists ? 'ok' : 'error'}>{d.exists ? <><Check className="mr-1 h-3 w-3" />Found</> : <><X className="mr-1 h-3 w-3" />Missing</>}</Badge><Badge tone={d.writable ? 'ok' : 'error'}>{d.writable ? 'Writable' : 'Not writable'}</Badge></div>
          </div>))}
      </div>
      <h2 className="mb-2 mt-8 font-display text-base font-semibold">Consistency check</h2>
      {r.orphans.missingFiles.length === 0 && r.orphans.unknownFiles.length === 0 ? <Notice tone="ok">Every video record has its file, and every file on disk belongs to a record.</Notice> : (
        <div className="space-y-3">
          {r.orphans.missingFiles.length > 0 && <Notice tone="warn"><strong>{r.orphans.missingFiles.length} video record(s) have no file on disk</strong> (their URLs return 404). IDs: <span className="break-all font-mono text-xs">{r.orphans.missingFiles.slice(0, 5).join(', ')}{r.orphans.missingFiles.length > 5 ? ' ...' : ''}</span>. Move them to the trash and delete them from the Video library.</Notice>}
          {r.orphans.unknownFiles.length > 0 && <Notice tone="warn"><strong>{r.orphans.unknownFiles.length} file(s) on disk are not tracked</strong>: <span className="break-all font-mono text-xs">{r.orphans.unknownFiles.slice(0, 5).join(', ')}{r.orphans.unknownFiles.length > 5 ? ' ...' : ''}</span>. The app never deletes unknown files; remove them manually if they are not needed.</Notice>}
        </div>)}
      <div className="mt-8"><Notice>To move storage to another drive, stop the app, move the whole <span className="font-mono">storage</span> folder, and set <span className="font-mono">STORAGE_ROOT</span> in <span className="font-mono">.env</span>. The dashboard intentionally has no file browser or live path switch, to avoid data loss and path-traversal risk.</Notice></div>
      {confirm && <ConfirmDialog title="Clean up temp files?" confirmLabel="Clean up" onClose={() => setConfirm(false)} onConfirm={cleanup} message={<p>Deletes files in the temp folder that are older than 60 minutes and not part of an active upload. Videos are not affected.</p>} />}
    </>
  );
}
