import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatBytes, formatDate, type VideoItem } from '../api';
import { useApp } from '../App';
import { Badge, ErrorBox, Notice, PageHeader, Spinner } from '../ui';

interface LibStat { total: number; active: number; trashed: number; activeBytes: number; trashedBytes: number }
interface OverviewData {
  media?: { video: LibStat | null; image: LibStat | null; file: LibStat | null };
  totals: { total: number; active: number; trashed: number; activeBytes: number; trashedBytes: number; uploadsToday: number };
  disk: { freeBytes: number; totalBytes: number } | null;
  recentUploads: VideoItem[];
  recentEvents: { id: number; type: string; createdAt: string; actor: string | null; metadata: Record<string, unknown> | null }[];
  health: { api: string; storage: 'ok' | 'warn' | 'error'; messages: { level: string; text: string }[] };
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="card p-4"><div className="text-xs font-medium text-ink-500">{label}</div><div className="mt-1.5 font-display text-2xl font-semibold tabular-nums text-ink-950">{value}</div>{sub && <div className="mt-0.5 text-xs text-ink-500">{sub}</div>}</div>;
}

export default function Overview() {
  const { settings } = useApp();
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api<OverviewData>('/overview').then(setData).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  if (error) return <ErrorBox message={error} onRetry={() => { setError(null); load(); }} />;
  if (!data) return <Spinner />;
  const { totals, disk, health } = data;
  const tone = health.storage === 'ok' ? 'ok' : health.storage === 'warn' ? 'warn' : 'error';
  return (
    <>
      <PageHeader title="Overview" subtitle="Live numbers from the database and your disk." />
      {health.messages.length > 0 && <div className="mb-5 space-y-2">{health.messages.slice(0, 3).map((m, i) => <Notice key={i} tone="warn">{m.text}</Notice>)}{health.messages.length > 3 && <Link className="text-sm text-reel-700 underline" to="/system">See all {health.messages.length} findings</Link>}</div>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total videos" value={totals.total.toLocaleString()} sub="video library" />
        <Stat label="Active" value={totals.active.toLocaleString()} sub={formatBytes(totals.activeBytes)} />
        <Stat label="In trash" value={totals.trashed.toLocaleString()} sub={formatBytes(totals.trashedBytes)} />
        <Stat label="Uploads today" value={totals.uploadsToday.toLocaleString()} />
        <Stat label="Video storage used" value={formatBytes(totals.activeBytes + totals.trashedBytes)} sub="active + trash" />
        <Stat label="Free disk space" value={disk ? formatBytes(disk.freeBytes) : 'Unknown'} sub={disk ? `of ${formatBytes(disk.totalBytes)}` : 'Not reported by this system'} />
        <div className="card flex items-center justify-between p-4"><div><div className="text-xs font-medium text-ink-500">API</div><div className="mt-2"><Badge tone="ok">Online</Badge></div></div></div>
        <div className="card flex items-center justify-between p-4"><div><div className="text-xs font-medium text-ink-500">Storage health</div><div className="mt-2"><Badge tone={tone}>{health.storage === 'ok' ? 'Healthy' : health.storage === 'warn' ? 'Needs attention' : 'Problem'}</Badge></div></div></div>
      </div>
      {data.media && (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {([['video', 'Videos', '/videos'], ['image', 'Images', '/images'], ['file', 'Files', '/files']] as const).map(([k, label, to]) => {
            const m = data.media![k];
            return <Link key={k} to={to} className="card block p-4 transition-colors hover:bg-ink-50"><div className="text-xs font-medium text-ink-500">{label} library</div><div className="mt-1.5 font-display text-2xl font-semibold tabular-nums text-ink-950">{(m?.active ?? 0).toLocaleString()}</div><div className="mt-0.5 text-xs text-ink-500">{formatBytes(m?.activeBytes ?? 0)} active &middot; {(m?.trashed ?? 0).toLocaleString()} in trash</div></Link>;
          })}
        </div>
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="card">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3"><h2 className="font-display text-sm font-semibold">Recent uploads</h2><Link to="/videos" className="text-xs text-reel-700 hover:underline">View all</Link></div>
          {data.recentUploads.length === 0 ? <p className="p-6 text-sm text-ink-500">No uploads yet. Create an API key and send your first video.</p> : (
            <ul className="divide-y divide-ink-100">{data.recentUploads.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0"><div className="truncate font-medium text-ink-800">{v.originalName}</div><div className="text-xs text-ink-500">{formatDate(v.createdAt, settings)}</div></div>
                <div className="flex shrink-0 items-center gap-2"><span className="text-xs text-ink-500">{formatBytes(v.size)}</span>{v.status === 'trashed' && <Badge tone="warn">Trash</Badge>}</div>
              </li>))}</ul>)}
        </section>
        <section className="card">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3"><h2 className="font-display text-sm font-semibold">Latest events</h2><Link to="/logs" className="text-xs text-reel-700 hover:underline">All activity</Link></div>
          {data.recentEvents.length === 0 ? <p className="p-6 text-sm text-ink-500">Nothing logged yet.</p> : (
            <ul className="divide-y divide-ink-100">{data.recentEvents.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0"><div className="font-medium text-ink-800">{e.type.replace(/_/g, ' ')}</div><div className="truncate text-xs text-ink-500">{e.actor ?? 'anonymous'}</div></div>
                <div className="shrink-0 text-xs text-ink-500">{formatDate(e.createdAt, settings)}</div>
              </li>))}</ul>)}
        </section>
      </div>
    </>
  );
}
