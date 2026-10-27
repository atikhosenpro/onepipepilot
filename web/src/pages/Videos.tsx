import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Eye, Filter, Info, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { api, formatBytes, formatDate, itemUrl, type MediaKind, type Paged, type VideoItem } from '../api';
import { useApp } from '../App';
import { Badge, ConfirmDialog, CopyButton, Empty, ErrorBox, Modal, Notice, PageHeader, Pagination, Spinner, useDebounced, useToast } from '../ui';

type SortKey = string;
type Filters = Record<string, string>;
const TITLES: Record<MediaKind, { title: string; subtitle: string; empty: string; noun: string }> = {
  video: { title: 'Video library', subtitle: 'Every video here is reachable by anyone who has its link, without signing in.', empty: 'Create an API key, then POST a video to /api/v1/videos. See API docs.', noun: 'video' },
  image: { title: 'Image library', subtitle: 'Images are served from public links. SVG is delivered in a sandbox so scripts cannot run.', empty: 'POST an image to /api/v1/images with your API key. See API docs.', noun: 'image' },
  file: { title: 'File library', subtitle: 'Documents, archives, audio and any other file. Active content (HTML, JS, PHP, XML) is always delivered as a download.', empty: 'POST a file to /api/v1/files with your API key. See API docs.', noun: 'file' },
};
const ASPECTS = ['16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9', '3:2'];
const FILE_CATEGORIES = ['document', 'archive', 'code', 'audio', 'data', 'other'];
const RES_CATS = ['4K', '1440p', '1080p', '720p', '480p', '360p', '240p', 'below-240p'];
const META_TONE: Record<string, 'ok' | 'warn' | 'error' | 'neutral'> = { ready: 'ok', pending: 'neutral', processing: 'neutral', unavailable: 'warn', failed: 'error' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-ink-600"><span className="mb-1 block">{label}</span>{children}</label>;
}

export default function Videos({ mode, kind = 'video' }: { mode: 'active' | 'trashed'; kind?: MediaKind }) {
  const { settings } = useApp();
  const toast = useToast();
  const trash = mode === 'trashed';
  const lib = TITLES[kind];
  const [data, setData] = useState<Paged<VideoItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [filters, setFilters] = useState<Filters>({});
  const [showFilters, setShowFilters] = useState(false);
  const dFilters = useDebounced(filters, 400);
  const [sort, setSort] = useState<SortKey>(trash ? 'trashedAt' : 'createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<VideoItem | null>(null);
  const [detail, setDetail] = useState<VideoItem | null>(null);
  const [confirm, setConfirm] = useState<null | 'trash' | 'delete' | 'empty'>(null);
  const [single, setSingle] = useState<VideoItem | null>(null);

  useEffect(() => { setPage(1); setSelected(new Set()); setSort(trash ? 'trashedAt' : 'createdAt'); setOrder('desc'); setQ(''); setFilters({}); }, [mode, kind, trash]);
  useEffect(() => { setPage(1); }, [dq, dFilters]);
  const setF = (k: string, v: string) => setFilters((f) => { const n = { ...f }; if (v === '') delete n[k]; else n[k] = v; return n; });
  const activeCount = Object.keys(filters).filter((k) => !(k === 'status' && filters[k] === 'active')).length;

  const load = useCallback(() => {
    const qs = new URLSearchParams({ mediaType: trash ? 'all' : kind, status: trash ? 'trashed' : 'active', page: String(page), pageSize: '25', sortBy: sort, order });
    if (dq) qs.set('search', dq);
    for (const [k, v] of Object.entries(dFilters)) if (v !== '') qs.set(k, v);
    api<Paged<VideoItem>>(`/videos?${qs}`).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [trash, kind, page, dq, dFilters, sort, order]);
  useEffect(load, [load]);

  const toggleSort = (k: SortKey) => { if (sort === k) setOrder(order === 'asc' ? 'desc' : 'asc'); else { setSort(k); setOrder(k === 'originalName' ? 'asc' : 'desc'); } };
  const SortHead = ({ k, children }: { k: SortKey; children: string }) => (
    <th className="th" aria-sort={sort === k ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="inline-flex items-center gap-1 hover:text-ink-800" onClick={() => toggleSort(k)}>{children}{sort === k && (order === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</button>
    </th>
  );

  const run = async (path: string, ids: string[], okText: string) => {
    try {
      const r = await api<{ succeeded: number; failed: number }>(path, { method: 'POST', body: { ids } });
      toast(r.failed ? 'error' : 'success', r.failed ? `${r.succeeded} done, ${r.failed} failed. See Activity logs.` : okText);
    } catch (e) { toast('error', (e as Error).message); }
    setSelected(new Set()); load();
  };

  const items = data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((v) => selected.has(v.id));
  const ids = single ? [single.id] : [...selected];
  const cols = trash ? 'all' : kind;
  const metaBadge = useMemo(() => (v: VideoItem) => (v.metadataStatus === 'ready' || v.mediaType === 'file' ? null : (
    <span title={v.metadataError ?? undefined}><Badge tone={META_TONE[v.metadataStatus]}>{v.metadataStatus === 'unavailable' ? 'Metadata unavailable' : v.metadataStatus === 'failed' ? 'Metadata failed' : 'Analysing'}</Badge></span>
  )), []);
  const canPreview = (v: VideoItem) => v.mediaType === 'video' || v.mediaType === 'image' || v.category === 'audio';

  return (
    <>
      <PageHeader
        title={trash ? 'Trash' : lib.title}
        subtitle={trash ? `Trashed videos, images and files have no public link. They are deleted automatically after ${settings?.trashRetentionDays ? settings.trashRetentionDays + ' days' : 'never (retention is off)'}.` : lib.subtitle}
        actions={trash && (data?.total ?? 0) > 0 ? <button className="btn-danger" onClick={() => setConfirm('empty')}><Trash2 className="h-4 w-4" />Empty trash</button> : undefined}
      />
      {!trash && kind === 'video' && <div className="mb-4"><Notice>Public video links are intentionally unauthenticated so Buffer and browsers can fetch them. Links are long random IDs, but anyone who learns one can watch the video until you move it to the trash.</Notice></div>}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 p-3">
          <div className="relative min-w-[14rem] flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ink-400" /><input className="input pl-9" placeholder="Search by filename or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${trash ? 'trash' : lib.noun + 's'}`} /></div>
          <button className="btn-secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}><Filter className="h-4 w-4" />Filters{activeCount > 0 && <span className="rounded-full bg-reel-700 px-1.5 text-xs text-white">{activeCount}</span>}</button>
          {selected.size > 0 && (
            <div className="flex items-center gap-2 text-sm"><span className="text-ink-600">{selected.size} selected</span>
              {trash ? (<><button className="btn-secondary btn-sm" onClick={() => run('/videos/restore', [...selected], 'Restored.')}><RotateCcw className="h-3.5 w-3.5" />Restore</button><button className="btn-danger btn-sm" onClick={() => { setSingle(null); setConfirm('delete'); }}>Delete forever</button></>)
                : <button className="btn-danger btn-sm" onClick={() => { setSingle(null); setConfirm('trash'); }}><Trash2 className="h-3.5 w-3.5" />Move to trash</button>}
            </div>
          )}
        </div>
        {showFilters && (
          <div className="border-b border-ink-100 bg-ink-50/50 p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {!trash && <Field label="Status"><select className="input" value={filters.status ?? 'active'} onChange={(e) => setF('status', e.target.value === 'active' ? '' : e.target.value)}><option value="active">Active</option><option value="trashed">Trashed</option><option value="all">All</option></select></Field>}
              <Field label={kind === 'image' ? 'Format / extension' : 'Extension'}><input className="input" placeholder={kind === 'video' ? 'mp4, mkv ...' : kind === 'image' ? 'png, jpg ...' : 'pdf, zip ...'} value={filters.extension ?? ''} onChange={(e) => setF('extension', e.target.value)} /></Field>
              <Field label="MIME type"><input className="input" placeholder={kind === 'video' ? 'video/mp4 or video/*' : kind === 'image' ? 'image/png' : 'application/pdf'} value={filters.mimeType ?? ''} onChange={(e) => setF('mimeType', e.target.value)} /></Field>
              {kind === 'file' && <Field label="Category"><select className="input" value={filters.category ?? ''} onChange={(e) => setF('category', e.target.value)}><option value="">Any</option>{FILE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>}
              <Field label="Min size (MB)"><input className="input" type="number" min="0" step="any" value={filters.minSizeMB ?? ''} onChange={(e) => setF('minSizeMB', e.target.value)} /></Field>
              <Field label="Max size (MB)"><input className="input" type="number" min="0" step="any" value={filters.maxSizeMB ?? ''} onChange={(e) => setF('maxSizeMB', e.target.value)} /></Field>
              {kind === 'video' && <>
                <Field label="Min duration (s)"><input className="input" type="number" min="0" step="any" value={filters.minDuration ?? ''} onChange={(e) => setF('minDuration', e.target.value)} /></Field>
                <Field label="Max duration (s)"><input className="input" type="number" min="0" step="any" value={filters.maxDuration ?? ''} onChange={(e) => setF('maxDuration', e.target.value)} /></Field>
                <Field label={`Length (short = up to ${settings?.shortVideoMaxSeconds ?? 60}s)`}><select className="input" value={filters.videoClass ?? ''} onChange={(e) => setF('videoClass', e.target.value)}><option value="">Short and long</option><option value="short">Short only</option><option value="long">Long only</option></select></Field>
                <Field label="Resolution class"><select className="input" value={filters.resolutionCategory ?? ''} onChange={(e) => setF('resolutionCategory', e.target.value)}><option value="">Any</option>{RES_CATS.map((c) => <option key={c}>{c}</option>)}</select></Field>
              </>}
              {kind !== 'file' && <>
                <Field label="Aspect ratio"><select className="input" value={filters.aspectRatio ?? ''} onChange={(e) => setF('aspectRatio', e.target.value)}><option value="">Any</option>{ASPECTS.map((a) => <option key={a}>{a}</option>)}</select></Field>
                <Field label="Orientation"><select className="input" value={filters.orientation ?? ''} onChange={(e) => setF('orientation', e.target.value)}><option value="">Any</option><option value="landscape">Landscape</option><option value="portrait">Portrait</option><option value="square">Square</option></select></Field>
                <Field label="Min width (px)"><input className="input" type="number" min="0" value={filters.minWidth ?? ''} onChange={(e) => setF('minWidth', e.target.value)} /></Field>
                <Field label="Max width (px)"><input className="input" type="number" min="0" value={filters.maxWidth ?? ''} onChange={(e) => setF('maxWidth', e.target.value)} /></Field>
                <Field label="Min height (px)"><input className="input" type="number" min="0" value={filters.minHeight ?? ''} onChange={(e) => setF('minHeight', e.target.value)} /></Field>
                <Field label="Max height (px)"><input className="input" type="number" min="0" value={filters.maxHeight ?? ''} onChange={(e) => setF('maxHeight', e.target.value)} /></Field>
                <Field label="Exact resolution"><input className="input" placeholder="1920x1080" value={filters.resolution ?? ''} onChange={(e) => setF('resolution', e.target.value)} /></Field>
                <Field label="Metadata"><select className="input" value={filters.metadataStatus ?? ''} onChange={(e) => setF('metadataStatus', e.target.value)}><option value="">Any</option><option value="ready">Ready</option><option value="pending">Pending</option><option value="unavailable">Unavailable</option><option value="failed">Failed</option></select></Field>
              </>}
              <Field label="Uploaded from"><input className="input" type="date" value={filters.uploadedFrom ?? ''} onChange={(e) => setF('uploadedFrom', e.target.value)} /></Field>
              <Field label="Uploaded to"><input className="input" type="date" value={filters.uploadedTo ?? ''} onChange={(e) => setF('uploadedTo', e.target.value)} /></Field>
              <Field label="Sort by"><select className="input" value={sort} onChange={(e) => { setSort(e.target.value); setOrder(e.target.value === 'originalName' ? 'asc' : 'desc'); }}>
                <option value={trash ? 'trashedAt' : 'createdAt'}>{trash ? 'Date trashed' : 'Upload date'}</option>{trash && <option value="createdAt">Upload date</option>}<option value="originalName">Filename</option><option value="size">Size</option>
                {kind === 'video' && !trash && <option value="durationSeconds">Duration</option>}{kind !== 'file' && !trash && <><option value="width">Width</option><option value="height">Height</option></>}</select></Field>
              <Field label="Order"><select className="input" value={order} onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')}><option value="desc">Descending</option><option value="asc">Ascending</option></select></Field>
            </div>
            {activeCount > 0 && <button className="btn-ghost btn-sm mt-3" onClick={() => setFilters({})}><X className="h-3.5 w-3.5" />Clear all filters</button>}
          </div>
        )}
        {error ? <div className="p-4"><ErrorBox message={error} onRetry={load} /></div> : !data ? <Spinner /> : items.length === 0 ? (
          <Empty title={dq || activeCount ? 'No matches' : trash ? 'The trash is empty' : `No ${lib.noun}s yet`} text={dq || activeCount ? 'Try different filters or search text.' : trash ? undefined : lib.empty} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem]">
              <thead className="border-b border-ink-100 bg-ink-50/60"><tr>
                <th className="th w-10"><input type="checkbox" aria-label="Select all on page" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(items.map((v) => v.id)))} /></th>
                <SortHead k="originalName">File</SortHead><th className="th">Type</th><SortHead k="size">Size</SortHead>
                {cols === 'video' && <SortHead k="durationSeconds">Duration</SortHead>}
                {(cols === 'video' || cols === 'image') && <SortHead k="width">Dimensions</SortHead>}
                <SortHead k={trash ? 'trashedAt' : 'createdAt'}>{trash ? 'Trashed' : 'Uploaded'}</SortHead><SortHead k="status">Status</SortHead><th className="th text-right">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((v) => (
                  <tr key={v.id} className="hover:bg-ink-50/50">
                    <td className="td"><input type="checkbox" aria-label={`Select ${v.originalName}`} checked={selected.has(v.id)} onChange={() => { const n = new Set(selected); if (n.has(v.id)) n.delete(v.id); else n.add(v.id); setSelected(n); }} /></td>
                    <td className="td max-w-xs"><div className="flex items-center gap-3">
                      {v.mediaType === 'image' && v.status === 'active' && <img src={itemUrl(v)} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded border border-ink-100 bg-ink-50 object-cover" />}
                      <div className="min-w-0"><div className="truncate font-medium" title={v.originalName}>{v.originalName}</div><div className="truncate font-mono text-xs text-ink-500" title={v.id}>{v.id}</div><div className="truncate font-mono text-xs text-ink-400" title={v.sha256}>sha256 {v.sha256.slice(0, 16)}...</div></div></div></td>
                    <td className="td text-xs text-ink-600"><div>{v.mimeType}</div>{trash && <Badge tone="neutral">{v.mediaType}</Badge>}{!trash && v.mediaType === 'file' && v.category && <Badge tone="neutral">{v.category}</Badge>}{!trash && v.mediaType === 'image' && v.imageFormat && <Badge tone="neutral">{v.imageFormat}</Badge>}</td>
                    <td className="td whitespace-nowrap tabular-nums">{formatBytes(v.size)}</td>
                    {cols === 'video' && <td className="td whitespace-nowrap text-xs">{v.durationSeconds != null ? <><div className="font-medium tabular-nums text-ink-800">{v.durationFormatted}</div>{v.videoClass && <Badge tone={v.isShort ? 'ok' : 'neutral'}>{v.isShort ? 'Short' : 'Long'}</Badge>}</> : <span className="text-ink-400">Unknown</span>}<div className="mt-1">{metaBadge(v)}</div></td>}
                    {(cols === 'video' || cols === 'image') && <td className="td whitespace-nowrap text-xs">{v.resolution ? <><div className="font-medium tabular-nums text-ink-800">{v.resolution}</div><div className="text-ink-500">{v.aspectRatio} &middot; {v.orientation}</div></> : <span className="text-ink-400">Unknown</span>}{cols === 'image' && <div className="mt-1">{metaBadge(v)}</div>}</td>}
                    <td className="td whitespace-nowrap text-xs text-ink-600">{formatDate(trash ? v.trashedAt : v.createdAt, settings)}</td>
                    <td className="td"><Badge tone={v.status === 'active' ? 'ok' : 'warn'}>{v.status === 'active' ? 'Active' : 'Trashed'}</Badge></td>
                    <td className="td"><div className="flex flex-wrap justify-end gap-1.5">
                      {v.status === 'active' && <>{canPreview(v) && <button className="btn-secondary btn-sm" onClick={() => setPreview(v)} title="Preview"><Eye className="h-3.5 w-3.5" />Preview</button>}
                        <CopyButton text={v.publicUrl ?? ''} label="Copy URL" done="Public URL copied" />
                        <a className="btn-secondary btn-sm" href={itemUrl(v, true)} title="Download"><Download className="h-3.5 w-3.5" /></a></>}
                      <button className="btn-secondary btn-sm" onClick={() => setDetail(v)} title="Details"><Info className="h-3.5 w-3.5" /></button>
                      {v.status === 'trashed' ? <><button className="btn-secondary btn-sm" onClick={() => run('/videos/restore', [v.id], 'Restored.')}><RotateCcw className="h-3.5 w-3.5" />Restore</button><button className="btn-danger btn-sm" onClick={() => { setSingle(v); setConfirm('delete'); }}>Delete</button></>
                        : <button className="btn-secondary btn-sm text-red-700" onClick={() => { setSingle(v); setConfirm('trash'); }} title="Move to trash"><Trash2 className="h-3.5 w-3.5" /></button>}
                    </div></td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />}
      </div>

      {preview && (
        <Modal title={preview.originalName} onClose={() => setPreview(null)} wide>
          {preview.mediaType === 'video' && <video className="w-full rounded-lg bg-black" src={itemUrl(preview)} controls autoPlay playsInline preload="metadata" />}
          {preview.mediaType === 'image' && <div className="flex justify-center rounded-lg bg-ink-100 p-2"><img src={itemUrl(preview)} alt={preview.originalName} className="max-h-[70vh] max-w-full rounded object-contain" /></div>}
          {preview.mediaType === 'file' && <audio className="w-full" src={itemUrl(preview)} controls autoPlay />}
          {preview.mediaType === 'video' && !['mp4', 'webm', 'm4v', 'mov'].includes(preview.extension) && <p className="mt-3 text-xs text-ink-500">Browsers can only play some formats natively. If the preview stays blank, download the file instead; the public link still serves it unchanged.</p>}
          <p className="mt-3 break-all font-mono text-xs text-ink-500">{preview.publicUrl}</p>
        </Modal>
      )}
      {detail && (
        <Modal title={`${detail.mediaType === 'file' ? 'File' : detail.mediaType === 'image' ? 'Image' : 'Video'} details`} onClose={() => setDetail(null)} wide>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
            {([
              ['ID', detail.id], ['Original filename', detail.originalName], ['Library', detail.mediaType], ['Extension', detail.extension], ['MIME type', detail.mimeType],
              ['Size', `${detail.sizeFormatted} (${detail.size.toLocaleString()} bytes)`], ['SHA-256', detail.sha256], ['Status', detail.status],
              ['Metadata', `${detail.metadataStatus}${detail.metadataSource ? ` (${detail.metadataSource})` : ''}`], ['Metadata note', detail.metadataError],
              ...(detail.mediaType === 'video' ? [['Duration', detail.durationSeconds != null ? `${detail.durationFormatted} (${detail.durationSeconds} s, ${detail.durationMinutes} min)` : null], ['Length class', detail.videoClass ? `${detail.videoClass} (threshold ${settings?.shortVideoMaxSeconds ?? 60} s)` : null], ['Frame rate', detail.frameRate != null ? `${detail.frameRate} fps` : null], ['Video codec', detail.videoCodec], ['Audio codec', detail.audioCodec], ['Resolution class', detail.resolutionCategory]] : []),
              ...(detail.mediaType !== 'file' ? [['Resolution', detail.resolution], ['Aspect ratio', detail.aspectRatio ? `${detail.aspectRatio} (${detail.aspectRatioValue})` : null], ['Orientation', detail.orientation]] : []),
              ...(detail.mediaType === 'image' ? [['Image format', detail.imageFormat], ['Alpha channel', detail.hasAlpha == null ? null : detail.hasAlpha ? 'yes' : 'no'], ['Color space', detail.colorSpace]] : []),
              ...(detail.mediaType === 'file' ? [['Category', detail.category]] : []),
              ['Uploaded', formatDate(detail.createdAt, settings)], ['Updated', formatDate(detail.updatedAt, settings)], ['Trashed', formatDate(detail.trashedAt, settings)],
              ['Public URL', detail.publicUrl ?? 'Unavailable while trashed'], ['Download URL', detail.downloadUrl ?? 'Unavailable while trashed'],
            ] as [string, string | null | undefined][]).map(([k, val]) => (
              <div key={k} className="contents"><dt className="font-medium text-ink-500">{k}</dt><dd className="break-all font-mono text-xs text-ink-800">{val == null || val === '' ? <span className="font-sans text-ink-400">Not available</span> : val}</dd></div>))}
          </dl>
          {detail.status === 'active' && detail.mediaType !== 'file' && detail.metadataStatus !== 'ready' && (
            <div className="mt-4"><button className="btn-secondary btn-sm" onClick={async () => { try { await api(`/videos/${detail.id}/reprocess`, { method: 'POST' }); toast('success', 'Metadata re-analysed.'); setDetail(null); load(); } catch (e) { toast('error', (e as Error).message); } }}>Retry metadata analysis</button></div>
          )}
          {detail.publicUrl && <div className="mt-5 flex gap-2"><CopyButton text={detail.publicUrl} label="Copy public URL" done="Public URL copied" /><CopyButton text={detail.downloadUrl ?? ''} label="Copy download URL" done="Download URL copied" /></div>}
        </Modal>
      )}
      {confirm === 'trash' && <ConfirmDialog title="Move to trash?" confirmLabel="Move to trash" danger onClose={() => setConfirm(null)} onConfirm={() => run('/videos/trash', ids, 'Moved to trash.')}
        message={<p>{ids.length === 1 ? <>"{single?.originalName ?? `This ${lib.noun}`}"</> : `${ids.length} items`} will stop being publicly accessible immediately. You can restore {ids.length === 1 ? 'it' : 'them'} from the trash.</p>} />}
      {confirm === 'delete' && <ConfirmDialog title="Delete permanently?" confirmLabel="Delete forever" danger onClose={() => setConfirm(null)} onConfirm={() => run('/videos/delete', ids, 'Deleted permanently.')}
        message={<p><strong>{ids.length === 1 ? 'This item' : `${ids.length} items`}</strong> and the stored file will be erased from disk. This cannot be undone.</p>} />}
      {confirm === 'empty' && <ConfirmDialog title="Empty the trash?" confirmLabel="Empty trash" danger requireText="EMPTY TRASH" onClose={() => setConfirm(null)}
        onConfirm={async () => { try { const r = await api<{ succeeded: number; failed: number }>('/trash/empty', { method: 'POST', body: { confirm: 'EMPTY TRASH' } }); toast(r.failed ? 'error' : 'success', `Deleted ${r.succeeded} item(s)${r.failed ? `, ${r.failed} failed` : ''}.`); } catch (e) { toast('error', (e as Error).message); } load(); }}
        message={<p>Every trashed video, image and file will be permanently deleted. This cannot be undone.</p>} />}
    </>
  );
}
