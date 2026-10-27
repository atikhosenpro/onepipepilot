import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { api, formatDate } from '../api';
import { useApp } from '../App';
import { Badge, ConfirmDialog, CopyButton, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Spinner, useToast } from '../ui';

interface Key { id: string; label: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; status: 'active' | 'revoked' }

export default function ApiKeys() {
  const { settings } = useApp();
  const toast = useToast();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Key | null>(null);
  const load = useCallback(() => { api<{ items: Key[] }>('/api-keys').then((r) => setKeys(r.items)).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try { const r = await api<{ key: string }>('/api-keys', { method: 'POST', body: { label } }); setCreated(r.key); setLabel(''); load(); }
    catch (err) { toast('error', (err as Error).message); }
  };

  return (
    <>
      <PageHeader title="API keys" subtitle="Keys authorise uploads to POST /api/v1/videos. Only a hash is stored, so a key can be shown exactly once." />
      <form onSubmit={create} className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[14rem] flex-1"><Field label="Label for the new key" htmlFor="label" hint="Example: n8n production"><input id="label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required /></Field></div>
        <button className="btn-primary"><Plus className="h-4 w-4" />Generate key</button>
      </form>
      <div className="card overflow-x-auto">
        {error ? <div className="p-4"><ErrorBox message={error} onRetry={load} /></div> : !keys ? <Spinner /> : keys.length === 0 ? <Empty title="No API keys yet" text="Generate a key to let n8n or another client upload videos." /> : (
          <table className="w-full min-w-[40rem]">
            <thead className="border-b border-ink-100 bg-ink-50/60"><tr><th className="th">Label</th><th className="th">Key</th><th className="th">Created</th><th className="th">Last used</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-ink-100">
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="td font-medium">{k.label}</td>
                  <td className="td font-mono text-xs text-ink-600">{k.prefix}...</td>
                  <td className="td text-xs text-ink-600">{formatDate(k.createdAt, settings)}</td>
                  <td className="td text-xs text-ink-600">{k.lastUsedAt ? formatDate(k.lastUsedAt, settings) : 'Never'}</td>
                  <td className="td"><Badge tone={k.status === 'active' ? 'ok' : 'neutral'}>{k.status === 'active' ? 'Active' : 'Revoked'}</Badge></td>
                  <td className="td text-right">{k.status === 'active' && <button className="btn-secondary btn-sm text-red-700" onClick={() => setRevoke(k)}>Revoke</button>}</td>
                </tr>))}
            </tbody>
          </table>)}
      </div>
      {created && (
        <Modal title="Your new API key" onClose={() => setCreated(null)}>
          <div className="space-y-4">
            <Notice tone="warn">Copy it now. For security it cannot be shown again; if you lose it, revoke it and generate another.</Notice>
            <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3"><KeyRound className="h-4 w-4 shrink-0 text-ink-500" /><code className="min-w-0 flex-1 break-all font-mono text-xs">{created}</code></div>
            <div className="flex justify-end gap-2"><CopyButton text={created} label="Copy key" done="API key copied" className="btn-primary" /><button className="btn-secondary" onClick={() => setCreated(null)}>Done</button></div>
          </div>
        </Modal>
      )}
      {revoke && <ConfirmDialog title="Revoke this key?" confirmLabel="Revoke key" danger onClose={() => setRevoke(null)}
        onConfirm={async () => { try { await api(`/api-keys/${revoke.id}/revoke`, { method: 'POST' }); toast('success', 'Key revoked. It stops working immediately.'); } catch (e) { toast('error', (e as Error).message); } load(); }}
        message={<p>Any workflow using <strong>{revoke.label}</strong> will start receiving 401 errors right away.</p>} />}
    </>
  );
}
