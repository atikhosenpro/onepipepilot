import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, Cloud, File as FileIcon, FileText, Film, Folder, FolderOpen, Image as ImageIcon, Info, Loader2, Music, Search, Users } from 'lucide-react';
import { api, formatBytes, formatDate } from '../api';
import { useApp } from '../App';
import { Badge, ConfirmDialog, CopyButton, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Spinner, useDebounced, useToast } from '../ui';

interface DriveStatus {
  status: 'not_configured' | 'disconnected' | 'connected' | 'reauthorization_required'; clientId: string; hasSecret: boolean; account: { email: string | null; name: string | null } | null;
  connectedAt: string | null; lastCheck: { at: string; ok: boolean; message: string } | null; redirectUri: string; importsRunning: number;
}
interface DriveItem {
  id: string; name: string; mimeType: string; kind: 'folder' | 'video' | 'image' | 'audio' | 'document' | 'other' | 'unsupported'; isShortcut: boolean; size: number | null; sizeFormatted: string | null;
  modifiedTime: string | null; importable: boolean; library: 'video' | 'image' | 'file' | null; webViewLink: string | null; owner: string | null; exportsAs: string | null;
}
interface Job { id: string; origin: string; state: 'queued' | 'running' | 'done' | 'failed'; name: string | null; library: string | null; bytes: number; total: number | null; duplicate: boolean; error: { code: string; message: string } | null; publicUrl: string | null; startedAt: string }
type Crumb = { id: string; name: string };

const STATUS_BADGE: Record<DriveStatus['status'], { tone: 'ok' | 'warn' | 'error' | 'neutral'; label: string }> = {
  connected: { tone: 'ok', label: 'Connected' }, disconnected: { tone: 'warn', label: 'Not connected' }, not_configured: { tone: 'neutral', label: 'Not configured' }, reauthorization_required: { tone: 'error', label: 'Reconnect required' },
};
const ICONS = { folder: Folder, video: Film, image: ImageIcon, audio: Music, document: FileText, other: FileIcon, unsupported: FileIcon } as const;
const REASONS: Record<string, string> = { denied: 'Google access was not granted.', invalid_state: 'The authorisation request expired or was already used. Click Connect again.', state_expired: 'The authorisation request expired. Click Connect again.', no_refresh_token: 'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.', oauth_exchange_failed: 'Google rejected the authorisation. Check the Client ID, Client Secret and redirect URI.', invalid_request: 'The response from Google was incomplete.' };

export default function Drive() {
  const { settings } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [st, setSt] = useState<DriveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const load = useCallback(() => api<DriveStatus>('/drive/status').then((s) => { setSt(s); setClientId((c) => c || s.clientId); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { // result of the Google redirect
    const r = params.get('result');
    if (!r) return;
    if (r === 'connected') setBanner({ tone: 'ok', text: 'Google Drive connected.' });
    else setBanner({ tone: 'warn', text: r === 'denied' ? REASONS.denied : (REASONS[params.get('reason') ?? ''] ?? 'Connecting Google Drive failed. Try again.') });
    navigate('/drive', { replace: true });
  }, [params, navigate]);

  const act = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(null); } };
  const save = (e: FormEvent) => { e.preventDefault(); void act('save', async () => { await api('/drive/config', { method: 'PUT', body: { clientId, ...(secret ? { clientSecret: secret } : {}) } }); setSecret(''); toast('success', 'Credentials saved (the secret is stored encrypted).'); await load(); }); };
  const connect = () => act('connect', async () => { const r = await api<{ authUrl: string }>('/drive/connect', { method: 'POST', body: {} }); window.location.assign(r.authUrl); });
  const test = () => act('test', async () => { const r = await api<{ message: string }>('/drive/test', { method: 'POST', body: {} }); toast('success', r.message); await load(); });

  if (error) return <ErrorBox message={error} onRetry={() => { setError(null); void load(); }} />;
  if (!st) return <Spinner />;
  const badge = STATUS_BADGE[st.status];

  return (
    <>
      <PageHeader title="Google Drive" subtitle="Let OnePipePilot pull files straight from Google Drive, so n8n only has to send a small link. Access is read-only and limited to what the connected Google account is allowed to see." />
      {banner && <div className="mb-4"><Notice tone={banner.tone}>{banner.text}</Notice></div>}

      <section className="card mb-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3"><Cloud className="h-5 w-5 text-ink-500" /><h2 className="font-display text-base font-semibold">Connection</h2><Badge tone={badge.tone}>{badge.label}</Badge></div>
          {st.account?.email && <span className="text-sm text-ink-600">Account: <strong>{st.account.email}</strong></span>}
        </div>
        {st.status === 'reauthorization_required' && <div className="mt-3"><Notice tone="warn">Google Drive access expired or was revoked. Click <strong>Reconnect</strong> to authorise again. Imports from n8n fail until then.</Notice></div>}
        {st.lastCheck && <p className="mt-3 text-xs text-ink-500">Last test: {formatDate(st.lastCheck.at, settings)} &middot; {st.lastCheck.ok ? 'OK' : 'failed'} &middot; {st.lastCheck.message}</p>}

        <form onSubmit={save} className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="OAuth Client ID" htmlFor="gd-id"><input id="gd-id" className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890-abc.apps.googleusercontent.com" autoComplete="off" required /></Field>
          <Field label="OAuth Client Secret" htmlFor="gd-secret" hint={st.hasSecret ? 'A secret is saved (encrypted). Leave blank to keep it.' : 'Stored encrypted on the server; never shown again.'}>
            <input id="gd-secret" className="input font-mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={st.hasSecret ? '••••••••••••••••' : 'GOCSPX-...'} autoComplete="new-password" required={!st.hasSecret} />
          </Field>
          <div className="md:col-span-2">
            <label className="label" htmlFor="gd-redirect">Authorised redirect URI (copy this into Google Cloud)</label>
            <div className="flex gap-2"><input id="gd-redirect" className="input font-mono" readOnly value={st.redirectUri} onFocus={(e) => e.target.select()} /><CopyButton text={st.redirectUri} done="Redirect URI copied" /></div>
            <p className="hint">Built from the Public base URL in Settings. If you change that URL, add the new redirect URI in Google Cloud too.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <button className="btn-secondary" disabled={busy !== null}>{busy === 'save' && <Loader2 className="h-4 w-4 animate-spin" />}Save credentials</button>
            <button type="button" className="btn-primary" onClick={connect} disabled={busy !== null || st.status === 'not_configured'}>{busy === 'connect' && <Loader2 className="h-4 w-4 animate-spin" />}{st.status === 'connected' || st.status === 'reauthorization_required' ? 'Reconnect' : 'Connect Google account'}</button>
            {(st.status === 'connected' || st.status === 'reauthorization_required') && <button type="button" className="btn-secondary" onClick={test} disabled={busy !== null}>{busy === 'test' && <Loader2 className="h-4 w-4 animate-spin" />}Test connection</button>}
            {st.status !== 'not_configured' && <button type="button" className="btn-ghost text-red-700" onClick={() => setConfirmDisconnect(true)} disabled={busy !== null}>Disconnect</button>}
          </div>
        </form>
        <details className="mt-4 text-sm text-ink-600"><summary className="cursor-pointer font-medium text-ink-700">How to get a Client ID and Secret</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>In <span className="font-mono">console.cloud.google.com</span> create or pick a project and enable the <strong>Google Drive API</strong>.</li>
            <li>Open <strong>OAuth consent screen</strong>, choose External, add yourself as a test user, and add the scope <span className="font-mono">drive.readonly</span>.</li>
            <li>Open <strong>Credentials</strong> &rarr; Create credentials &rarr; <strong>OAuth client ID</strong> &rarr; type <em>Web application</em>.</li>
            <li>Under <em>Authorised redirect URIs</em> paste the redirect URI shown above, then copy the Client ID and Client Secret here.</li>
            <li>Save, then click <strong>Connect Google account</strong>. If the app is in "Testing" mode Google expires the authorisation after 7 days; publish the app or reconnect weekly.</li>
          </ol>
        </details>
      </section>

      {st.status === 'connected' && <Browser />}
      <Imports onRunning={load} />
      {confirmDisconnect && <DisconnectDialog onClose={() => setConfirmDisconnect(false)} onDone={load} />}
    </>
  );
}

function DisconnectDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const [forget, setForget] = useState(false);
  return (
    <ConfirmDialog title="Disconnect Google Drive?" confirmLabel="Disconnect" danger onClose={onClose}
      onConfirm={async () => { try { await api('/drive/disconnect', { method: 'POST', body: { forget } }); toast('success', 'Google Drive disconnected and the tokens were erased.'); await onDone(); } catch (e) { toast('error', (e as Error).message); } }}
      message={<div className="space-y-3"><p>The saved tokens are revoked at Google and deleted here. Files already imported stay in your libraries; n8n imports stop working until you reconnect.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />Also delete the saved Client ID and Secret</label></div>} />
  );
}

function Browser() {
  const { settings } = useApp();
  const toast = useToast();
  const [mode, setMode] = useState<'mydrive' | 'shared'>('mydrive');
  const [stack, setStack] = useState<Crumb[]>([]);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 400);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const seq = useRef(0);
  const folderId = stack.length ? stack[stack.length - 1].id : 'root';

  const fetchPage = useCallback(async (token?: string) => {
    const my = ++seq.current;
    const qs = new URLSearchParams({ mode, pageSize: '50' });
    if (dq) qs.set('q', dq); else if (mode === 'mydrive') qs.set('folderId', folderId);
    if (token) qs.set('pageToken', token);
    try {
      const r = await api<{ items: DriveItem[]; nextPageToken: string | null }>(`/drive/files?${qs}`);
      if (my !== seq.current) return; // a newer request replaced this one
      setItems((cur) => (token ? [...cur, ...r.items] : r.items)); setNext(r.nextPageToken); setErr(null);
    } catch (e) { if (my === seq.current) setErr((e as Error).message); }
    finally { if (my === seq.current) { setLoading(false); setMore(false); } }
  }, [mode, dq, folderId]);
  useEffect(() => { setLoading(true); setItems([]); setNext(null); void fetchPage(); }, [fetchPage]);

  const open = (it: DriveItem) => { setQ(''); setStack((s) => [...s, { id: it.id, name: it.name }]); };
  const startImport = async (it: DriveItem) => { try { await api('/drive/import', { method: 'POST', body: { source: it.id, library: 'auto' } }); toast('info', `Importing "${it.name}" - see the progress below.`); } catch (e) { toast('error', (e as Error).message); } };

  return (
    <section className="card mb-6">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 p-3">
        <div className="inline-flex rounded-lg border border-ink-200 p-0.5 text-sm" role="tablist">
          {([['mydrive', 'My Drive', FolderOpen], ['shared', 'Shared with me', Users]] as const).map(([m, label, Icon]) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setStack([]); setQ(''); }} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 ${mode === m ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'}`}><Icon className="h-4 w-4" />{label}</button>))}
        </div>
        <div className="relative min-w-[14rem] flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ink-400" /><input className="input pl-9" placeholder="Search file names in Drive" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Google Drive" /></div>
      </div>
      {mode === 'mydrive' && !dq && (
        <nav className="flex flex-wrap items-center gap-1 border-b border-ink-100 px-4 py-2 text-sm" aria-label="Folder path">
          <button className="rounded px-1.5 py-0.5 text-reel-700 hover:bg-reel-50" onClick={() => setStack([])}>My Drive</button>
          {stack.map((c, i) => (<span key={c.id + i} className="flex items-center gap-1"><ChevronRight className="h-3.5 w-3.5 text-ink-400" /><button className={`rounded px-1.5 py-0.5 hover:bg-reel-50 ${i === stack.length - 1 ? 'font-medium text-ink-800' : 'text-reel-700'}`} onClick={() => setStack(stack.slice(0, i + 1))}>{c.name}</button></span>))}
          {stack.length > 0 && <button className="btn-ghost btn-sm ml-auto" onClick={() => setStack(stack.slice(0, -1))}>Up one level</button>}
        </nav>
      )}
      {err ? <div className="p-4"><ErrorBox message={err} onRetry={() => { setLoading(true); void fetchPage(); }} /></div> : loading ? <Spinner label="Loading Google Drive..." /> : items.length === 0 ? (
        <Empty title={dq ? 'No files match your search' : mode === 'shared' ? 'Nothing is shared with this account' : 'This folder is empty'} text={dq ? undefined : 'Only files this Google account can access are listed.'} />
      ) : (
        <div className="overflow-x-auto"><table className="w-full min-w-[44rem]">
          <thead className="border-b border-ink-100 bg-ink-50/60"><tr><th className="th">Name</th><th className="th">Type</th><th className="th">Size</th><th className="th">Modified</th><th className="th text-right">Actions</th></tr></thead>
          <tbody className="divide-y divide-ink-100">{items.map((it) => { const Icon = ICONS[it.kind]; return (
            <tr key={it.id} className="hover:bg-ink-50/50">
              <td className="td max-w-sm"><div className="flex items-center gap-2.5"><Icon className={`h-4 w-4 shrink-0 ${it.kind === 'folder' ? 'text-amber-500' : it.kind === 'video' ? 'text-reel-600' : it.kind === 'image' ? 'text-sky-600' : 'text-ink-400'}`} />
                {it.kind === 'folder' ? <button className="truncate text-left font-medium text-ink-900 hover:underline" onClick={() => open(it)} title={it.name}>{it.name}</button> : <span className="truncate font-medium" title={it.name}>{it.name}</span>}
                {it.isShortcut && <Badge tone="neutral">shortcut</Badge>}</div></td>
              <td className="td text-xs text-ink-600">{it.kind === 'folder' ? 'Folder' : it.kind === 'document' && it.exportsAs ? `Google document (exported as ${it.exportsAs})` : it.mimeType}</td>
              <td className="td whitespace-nowrap text-xs tabular-nums">{it.sizeFormatted ?? '-'}</td>
              <td className="td whitespace-nowrap text-xs text-ink-600">{it.modifiedTime ? formatDate(it.modifiedTime, settings) : '-'}</td>
              <td className="td"><div className="flex flex-wrap justify-end gap-1.5">
                {it.kind === 'folder' ? <button className="btn-secondary btn-sm" onClick={() => open(it)}>Open</button> : (<>
                  <button className="btn-secondary btn-sm" onClick={() => setInspect(it.id)} title="Inspect"><Info className="h-3.5 w-3.5" /></button>
                  <CopyButton text={it.webViewLink ?? it.id} label={it.webViewLink ? 'Copy link' : 'Copy ID'} done={it.webViewLink ? 'Drive link copied' : 'File ID copied'} />
                  {it.importable ? <button className="btn-primary btn-sm" onClick={() => startImport(it)}>Import</button> : <Badge tone="neutral">Not importable</Badge>}</>)}
              </div></td>
            </tr>); })}</tbody>
        </table></div>
      )}
      {next && !err && <div className="border-t border-ink-100 p-3 text-center"><button className="btn-secondary" disabled={more} onClick={() => { setMore(true); void fetchPage(next); }}>{more && <Loader2 className="h-4 w-4 animate-spin" />}Load more</button></div>}
      {inspect && <InspectModal id={inspect} onClose={() => setInspect(null)} />}
    </section>
  );
}

function InspectModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { settings } = useApp();
  const toast = useToast();
  const [d, setD] = useState<{ file: DriveItem & { md5Checksum: string | null; canDownload: boolean }; alreadyImported: { id: string; mediaType: string; publicUrl: string | null }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [library, setLibrary] = useState('auto');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<NonNullable<typeof d>>(`/drive/files/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id]);
  const doImport = async () => { setBusy(true); try { await api('/drive/import', { method: 'POST', body: { source: id, library } }); toast('info', 'Import started - see the progress below.'); onClose(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); } };
  return (
    <Modal title="Google Drive file" onClose={onClose} wide>
      {err ? <ErrorBox message={err} /> : !d ? <Spinner /> : (<div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-[10rem_1fr]">
          {([['Name', d.file.name], ['File ID', d.file.id], ['MIME type', d.file.mimeType], ['Size', d.file.sizeFormatted], ['Modified', d.file.modifiedTime ? formatDate(d.file.modifiedTime, settings) : null], ['Owner', d.file.owner], ['MD5 checksum', d.file.md5Checksum],
            ['Will be stored in', d.file.library ? `${d.file.library} library` : null], ['Downloadable', d.file.canDownload ? 'yes' : 'no (disabled by the owner)']] as [string, string | null][]).map(([k, v]) => (
            <div key={k} className="contents"><dt className="font-medium text-ink-500">{k}</dt><dd className="break-all font-mono text-xs">{v ?? <span className="font-sans text-ink-400">Not available</span>}</dd></div>))}
        </dl>
        {d.alreadyImported.length > 0 && <Notice tone="ok">Already imported ({d.alreadyImported.length}): importing again returns the existing copy unless the file changed in Drive.
          <ul className="mt-1 space-y-0.5 text-xs">{d.alreadyImported.map((a) => <li key={a.id} className="break-all font-mono">{a.publicUrl}</li>)}</ul></Notice>}
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={d.file.webViewLink ?? d.file.id} label={d.file.webViewLink ? 'Copy Drive link' : 'Copy file ID'} done="Copied" />
          <CopyButton text={d.file.id} label="Copy file ID" done="File ID copied" />
          {d.file.importable && d.file.canDownload && (<><select className="input w-auto" value={library} onChange={(e) => setLibrary(e.target.value)} aria-label="Library"><option value="auto">Auto-detect library</option><option value="video">Video library</option><option value="image">Image library</option><option value="file">File library</option></select>
            <button className="btn-primary" onClick={doImport} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Import into OnePipePilot</button></>)}
        </div>
      </div>)}
    </Modal>
  );
}

function Imports({ onRunning }: { onRunning: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const running = jobs.some((j) => j.state === 'running' || j.state === 'queued');
  const load = useCallback(() => api<{ items: Job[] }>('/drive/imports').then((r) => setJobs(r.items)).catch(() => undefined), []);
  useEffect(() => { void load(); const t = setInterval(load, running ? 1000 : 4000); return () => clearInterval(t); }, [load, running]);
  const prev = useRef(running);
  useEffect(() => { if (prev.current && !running) onRunning(); prev.current = running; }, [running, onRunning]);
  if (jobs.length === 0) return <section className="card p-5 text-sm text-ink-500"><h2 className="mb-1 font-display text-base font-semibold text-ink-800">Imports</h2>No imports yet. Files you import here, or that n8n sends as a Drive link, appear with live progress.</section>;
  return (
    <section className="card">
      <div className="border-b border-ink-100 px-5 py-3"><h2 className="font-display text-base font-semibold">Imports</h2></div>
      <ul className="divide-y divide-ink-100">{jobs.map((j) => { const pct = j.total ? Math.min(100, Math.round((j.bytes / j.total) * 100)) : null; return (
        <li key={j.id} className="space-y-1.5 px-5 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 truncate font-medium">{j.name ?? 'Google Drive file'}</span>
            <span className="flex items-center gap-2"><Badge tone="neutral">{j.origin === 'api' ? 'n8n / API' : 'dashboard'}</Badge>
              <Badge tone={j.state === 'done' ? 'ok' : j.state === 'failed' ? 'error' : 'warn'}>{j.state === 'done' ? (j.duplicate ? 'Already imported' : 'Done') : j.state === 'failed' ? 'Failed' : j.state === 'queued' ? 'Queued' : 'Downloading'}</Badge></span></div>
          {(j.state === 'running' || j.state === 'queued') && <div><div className="h-2 overflow-hidden rounded-full bg-ink-100" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}><div className={`h-full rounded-full bg-reel-600 transition-all ${pct == null ? 'w-1/3 animate-pulse' : ''}`} style={pct != null ? { width: `${pct}%` } : undefined} /></div>
            <p className="mt-1 text-xs text-ink-500">{formatBytes(j.bytes)}{j.total ? ` of ${formatBytes(j.total)} (${pct}%)` : ''}</p></div>}
          {j.state === 'failed' && j.error && <p className="text-xs text-red-700">{j.error.message} <span className="font-mono text-ink-400">({j.error.code})</span></p>}
          {j.state === 'done' && j.publicUrl && <div className="flex flex-wrap items-center gap-2"><span className="break-all font-mono text-xs text-ink-600">{j.publicUrl}</span><CopyButton text={j.publicUrl} done="Public URL copied" />
            <Link className="btn-secondary btn-sm" to={j.library === 'image' ? '/images' : j.library === 'file' ? '/files' : '/videos'}>Open library</Link></div>}
        </li>); })}</ul>
    </section>
  );
}
