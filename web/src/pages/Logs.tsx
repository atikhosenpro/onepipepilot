import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { api, formatDate, type Paged } from '../api';
import { useApp } from '../App';
import { Badge, Empty, ErrorBox, PageHeader, Pagination, Spinner, useDebounced } from '../ui';

interface Ev { id: number; type: string; createdAt: string; actor: string | null; ip: string | null; metadata: Record<string, unknown> | null }
const tone = (t: string): 'ok' | 'warn' | 'error' | 'neutral' => /failed|error/.test(t) ? 'error' : /deleted|revoked|trashed|emptied/.test(t) ? 'warn' : /success|uploaded|created|completed|restored/.test(t) ? 'ok' : 'neutral';

export default function Logs() {
  const { settings } = useApp();
  const [data, setData] = useState<(Paged<Ev> & { types: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [dq, type]);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (dq) qs.set('q', dq);
    if (type) qs.set('type', type);
    api<Paged<Ev> & { types: string[] }>(`/logs?${qs}`).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [page, dq, type]);
  useEffect(load, [load]);
  return (
    <>
      <PageHeader title="Activity logs" subtitle="Security and operational events. Passwords, API keys, setup tokens and cookies are never recorded." />
      <div className="card">
        <div className="flex flex-wrap gap-3 border-b border-ink-100 p-3">
          <div className="relative min-w-[14rem] flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ink-400" /><input className="input pl-9" placeholder="Search events, actors, IPs, details" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search logs" /></div>
          <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type"><option value="">All event types</option>{data?.types.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
          <button className="btn-secondary" onClick={load}>Refresh</button>
        </div>
        {error ? <div className="p-4"><ErrorBox message={error} onRetry={load} /></div> : !data ? <Spinner /> : data.items.length === 0 ? <Empty title="No events match" /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[48rem]">
            <thead className="border-b border-ink-100 bg-ink-50/60"><tr><th className="th">Time</th><th className="th">Event</th><th className="th">Actor</th><th className="th">IP</th><th className="th">Details</th></tr></thead>
            <tbody className="divide-y divide-ink-100">{data.items.map((e) => (
              <tr key={e.id} className="align-top"><td className="td whitespace-nowrap text-xs text-ink-600">{formatDate(e.createdAt, settings)}</td>
                <td className="td"><Badge tone={tone(e.type)}>{e.type.replace(/_/g, ' ')}</Badge></td>
                <td className="td text-xs">{e.actor ?? '-'}</td><td className="td font-mono text-xs text-ink-500">{e.ip ?? '-'}</td>
                <td className="td max-w-md break-words font-mono text-xs text-ink-600">{e.metadata ? Object.entries(e.metadata).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('  ') : ''}</td></tr>))}</tbody>
          </table></div>)}
        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />}
      </div>
    </>
  );
}
