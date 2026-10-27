import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { api, formatBytes, type Settings } from '../api';
import { useApp } from '../App';
import { Field, Notice, PageHeader, useToast } from '../ui';

const TYPES = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', 'wmv', 'flv', '3gp', 'ts', 'mts'];
const GB = 1024 ** 3;
const Section = ({ title, children }: { title: string; children: ReactNode }) => <section className="card space-y-4 p-5"><h2 className="font-display text-base font-semibold">{title}</h2>{children}</section>;

export default function SettingsPage() {
  const { settings, setSettings } = useApp();
  const toast = useToast();
  const [f, setF] = useState<Settings | null>(settings);
  const [maxGb, setMaxGb] = useState('1');
  const [warnGb, setWarnGb] = useState('5');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; message: string; ms: number } | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => { api<{ settings: Settings }>('/settings').then((r) => { setF(r.settings); setSettings(r.settings); setMaxGb(String(r.settings.maxUploadBytes / GB)); setWarnGb(String(r.settings.storageWarnFreeBytes / GB)); }); }, [setSettings]);
  if (!f) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF({ ...f, [k]: v });

  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const body = { ...f, maxUploadBytes: Math.round(Number(maxGb) * GB), storageWarnFreeBytes: Math.round(Number(warnGb) * GB) };
      const r = await api<{ settings: Settings }>('/settings', { method: 'PUT', body });
      setF(r.settings); setSettings(r.settings); setVerify(null); toast('success', 'Settings saved.');
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const doVerify = async () => { setVerifying(true); try { setVerify(await api('/settings/verify-url', { method: 'POST' })); } catch (e) { toast('error', (e as Error).message); } finally { setVerifying(false); } };
  const tz = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [f.timeZone];

  return (
    <>
      <PageHeader title="Settings" subtitle="Changes apply immediately to new uploads and newly generated links." />
      <form onSubmit={save} className="space-y-6">
        <Section title="Public URL">
          <Field label="Public base URL" htmlFor="base" hint="The address outside services use to reach this app, e.g. https://media.example.com. Links are always built from this value, never from request headers. Existing videos keep working.">
            <input id="base" className="input font-mono" value={f.publicBaseUrl} onChange={(e) => set('publicBaseUrl', e.target.value)} placeholder="https://media.example.com" required />
          </Field>
          <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn-secondary" onClick={doVerify} disabled={verifying}>{verifying && <Loader2 className="h-4 w-4 animate-spin" />}Verify saved URL</button><span className="text-xs text-ink-500">Save first, then verify. Tests <span className="font-mono">/api/v1/health</span> on the saved URL.</span></div>
          {verify && <Notice tone={verify.ok ? 'ok' : 'warn'}>{verify.message} ({verify.ms} ms)</Notice>}
          <Notice>Cloudflare Tunnel (or any reverse proxy) is configured outside this app. Point it at this app's local address, then enter the public hostname above.</Notice>
        </Section>
        <Section title="Uploads">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Maximum upload size (GB)" htmlFor="max" hint={`Currently ${formatBytes(Math.round(Number(maxGb) * GB) || 0)}. Allowed range 0.001 to 50.`}><input id="max" type="number" step="any" min="0.001" max="50" className="input" value={maxGb} onChange={(e) => setMaxGb(e.target.value)} required /></Field>
            <Field label="Multipart file field name" htmlFor="field" hint="n8n: set the Form-Data parameter name to this value."><input id="field" className="input font-mono" value={f.fieldName} onChange={(e) => set('fieldName', e.target.value)} required /></Field>
          </div>
          <fieldset><legend className="label">Allowed video types (Video library)</legend><div className="flex flex-wrap gap-4">{TYPES.map((t) => <label key={t} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.allowedTypes.includes(t)} onChange={() => set('allowedTypes', f.allowedTypes.includes(t) ? f.allowedTypes.filter((x) => x !== t) : [...f.allowedTypes, t])} />.{t}</label>)}</div><p className="hint">Videos are identified by their actual content, not by extension or client-supplied MIME type. The Image and File libraries are not limited by this list; the size limit and field name above apply to all three libraries.</p></fieldset>
        </Section>
        <Section title="Media metadata">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Short video: up to (seconds)" htmlFor="short" hint="Videos at or below this duration are classified as short, longer ones as long. This is this app's own label, not a social-network rule. Changing it re-classifies existing videos immediately."><input id="short" type="number" min="1" max="86400" step="any" className="input" value={f.shortVideoMaxSeconds} onChange={(e) => set('shortVideoMaxSeconds', Number(e.target.value))} required /></Field>
            <Field label="Analysis time limit (seconds)" htmlFor="mto" hint="Maximum time for analysing one file. A slow or broken file is stored anyway and marked unavailable or failed."><input id="mto" type="number" min="5" max="600" className="input" value={f.metadataTimeoutSeconds} onChange={(e) => set('metadataTimeoutSeconds', Number(e.target.value))} required /></Field>
          </div>
          <Notice>FFprobe status and the "analyse existing files" job are on the System page.</Notice>
        </Section>
        <Section title="Retention">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Move uploads to trash after (days)" htmlFor="ur" hint="0 = keep forever. Never deletes permanently; videos go to the trash first."><input id="ur" type="number" min="0" max="3650" className="input" value={f.uploadRetentionDays} onChange={(e) => set('uploadRetentionDays', Number(e.target.value))} /></Field>
            <Field label="Delete trashed videos after (days)" htmlFor="tr" hint="0 = never delete automatically."><input id="tr" type="number" min="0" max="3650" className="input" value={f.trashRetentionDays} onChange={(e) => set('trashRetentionDays', Number(e.target.value))} /></Field>
          </div>
        </Section>
        <Section title="Health warnings and logging">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Warn when free disk below (GB)" htmlFor="warn"><input id="warn" type="number" step="any" min="0" className="input" value={warnGb} onChange={(e) => setWarnGb(e.target.value)} /></Field>
            <Field label="Keep activity logs (days)" htmlFor="aud"><input id="aud" type="number" min="1" max="3650" className="input" value={f.auditRetentionDays} onChange={(e) => set('auditRetentionDays', Number(e.target.value))} /></Field>
            <Field label="Log file level" htmlFor="lvl"><select id="lvl" className="input" value={f.logLevel} onChange={(e) => set('logLevel', e.target.value as Settings['logLevel'])}>{['debug', 'info', 'warn', 'error'].map((l) => <option key={l}>{l}</option>)}</select></Field>
          </div>
        </Section>
        <Section title="Display">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Time zone" htmlFor="tz"><select id="tz" className="input" value={f.timeZone} onChange={(e) => set('timeZone', e.target.value)}>{tz.includes(f.timeZone) ? null : <option>{f.timeZone}</option>}{tz.map((z) => <option key={z}>{z}</option>)}</select></Field>
            <Field label="Clock" htmlFor="clk"><select id="clk" className="input" value={f.timeFormat} onChange={(e) => set('timeFormat', e.target.value as Settings['timeFormat'])}><option value="24h">24-hour</option><option value="12h">12-hour</option></select></Field>
          </div>
        </Section>
        {err && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        <div className="sticky bottom-0 -mx-4 border-t border-ink-100 bg-ink-50/90 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8"><button className="btn-primary" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save settings</button></div>
      </form>
    </>
  );
}
