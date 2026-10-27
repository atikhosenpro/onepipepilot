import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { api } from '../api';
import { Notice } from '../ui';

/** FormSubmit AJAX endpoint. The browser posts here directly, so the page never reloads or redirects. */
const FORMSUBMIT_URL = 'https://formsubmit.co/ajax/atikwebpro@gmail.com';
export const ONBOARDED_KEY = 'lvh_onboarded';
export const markOnboarded = () => { try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* storage unavailable */ } };
export const wasOnboarded = () => { try { return localStorage.getItem(ONBOARDED_KEY) === '1'; } catch { return false; } };

const USE_CASES = ['Host videos for Buffer / social scheduling', 'Feed n8n or other automations', 'Host images', 'Share files and documents', 'Personal backup / archive', 'Something else'];
const TOOLS = ['n8n', 'Buffer', 'YouTube', 'Make / Zapier', 'WordPress / WooCommerce', 'Custom scripts / API'];
const VOLUMES = ['A few per month', 'A few per week', 'Daily', 'Many per day'];
const SIZES = ['Under 50 MB', '50 - 300 MB', '300 MB - 1 GB', 'Over 1 GB'];
const HOSTING = ['This computer (Windows)', 'This computer (Mac / Linux)', 'A VPS / server', 'Not decided yet'];
const STEPS = ['About you', 'How you will use it', 'Your setup', 'Review'];

interface Answers { name: string; email: string; role: string; useCases: string[]; tools: string[]; volume: string; fileSize: string; hosting: string; notes: string }
const empty: Answers = { name: '', email: '', role: '', useCases: [], tools: [], volume: '', fileSize: '', hosting: '', notes: '' };

function Chips({ options, value, onToggle, label }: { options: string[]; value: string[]; onToggle: (v: string) => void; label: string }) {
  return (
    <fieldset><legend className="label">{label}</legend>
      <div className="flex flex-wrap gap-2">{options.map((o) => {
        const on = value.includes(o);
        return <button key={o} type="button" role="checkbox" aria-checked={on} onClick={() => onToggle(o)}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? 'border-reel-700 bg-reel-700 text-white' : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'}`}>{on && <Check className="-ml-0.5 mr-1 inline h-3.5 w-3.5" />}{o}</button>;
      })}</div></fieldset>
  );
}
function Radios({ options, value, onPick, label, name }: { options: string[]; value: string; onPick: (v: string) => void; label: string; name: string }) {
  return (
    <fieldset><legend className="label">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">{options.map((o) => (
        <label key={o} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${value === o ? 'border-reel-700 bg-reel-50' : 'border-ink-200 bg-white hover:bg-ink-50'}`}>
          <input type="radio" name={name} checked={value === o} onChange={() => onPick(o)} />{o}</label>))}</div></fieldset>
  );
}

/** Sends the answers to FormSubmit from the browser and explains precisely what went wrong if it fails. */
async function deliver(a: Answers): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Your device reports that it has no internet connection. Connect and try again, or skip.');
  const payload = {
    _subject: 'Local Video Host: new onboarding submission', _template: 'table', _captcha: 'false', _honey: '',
    name: a.name || '(not given)', email: a.email || '(not given)', role: a.role || '-', use_cases: a.useCases.join(', ') || '-', tools: a.tools.join(', ') || '-',
    monthly_uploads: a.volume || '-', typical_file_size: a.fileSize || '-', hosting: a.hosting || '-', notes: a.notes || '-', submitted_at: new Date().toISOString(),
    ...(a.email ? { _replyto: a.email } : {}),
  };
  let res: Response;
  try {
    res = await fetch(FORMSUBMIT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), referrerPolicy: 'origin', signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error((e as Error).name === 'TimeoutError'
      ? 'formsubmit.co did not answer in time. Check your connection and try again, or skip.'
      : 'This browser could not reach formsubmit.co. Your internet may be fine: a firewall, VPN, DNS filter or ad-blocker can block this one site. Try again, disable the blocker for this page, or skip.', { cause: e });
  }
  let body: { success?: unknown; message?: unknown } | null = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || body?.success === false || body?.success === 'false') {
    throw new Error(typeof body?.message === 'string' && body.message ? `FormSubmit says: ${body.message}` : `FormSubmit answered with HTTP ${res.status}. Please try again or skip.`);
  }
}

/** One-time, multi-step welcome questionnaire shown before the very first setup. Submits in the background (no page change). */
export function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [a, setA] = useState<Answers>(empty);
  const [busy, setBusy] = useState<null | 'submit' | 'skip'>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [delivered, setDelivered] = useState(false); // answers already reached FormSubmit; a retry then only records completion
  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => setA((x) => ({ ...x, [k]: v }));
  const toggle = (k: 'useCases' | 'tools') => (v: string) => setA((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((i) => i !== v) : [...x[k], v] }));

  const validate = (): string | null => {
    if (step === 0 && a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) return 'Please enter a valid e-mail address, or leave it empty.';
    if (step === 1 && a.useCases.length === 0) return 'Pick at least one way you plan to use it.';
    if (step === 2 && (!a.volume || !a.fileSize || !a.hosting)) return 'Please answer all three questions.';
    return null;
  };
  const next = () => { const e = validate(); setStepError(e); if (!e) setStep((s) => s + 1); };

  const finish = async (skip: boolean) => {
    setBusy(skip ? 'skip' : 'submit'); setError(null);
    try {
      if (!skip && !delivered) { await deliver(a); setDelivered(true); }
      await api('/onboarding', { method: 'POST', body: skip ? { skip: true } : { delivered: true } });
      markOnboarded();
      await onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-50 p-4 sm:p-8">
      <div className="card w-full max-w-2xl overflow-hidden">
        <div className="border-b border-ink-100 bg-ink-900 px-6 py-5 text-white">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-reel-600"><svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden><path d="M12 9l11 7-11 7z" fill="currentColor" /></svg></div>
            <div><h1 className="font-display text-lg font-semibold">Welcome to Local Video Host</h1><p className="text-sm text-ink-300">A quick welcome survey. It takes about a minute and is shown only once.</p></div>
          </div>
          <ol className="mt-5 flex gap-2" aria-label="Progress">{STEPS.map((s, i) => (
            <li key={s} className="flex-1" aria-current={i === step ? 'step' : undefined}><div className={`h-1.5 rounded-full ${i <= step ? 'bg-reel-400' : 'bg-ink-700'}`} /><div className={`mt-1.5 hidden text-xs sm:block ${i === step ? 'text-white' : 'text-ink-400'}`}>{i + 1}. {s}</div></li>))}</ol>
        </div>

        <div className="space-y-5 p-6">
          <p className="text-xs font-medium text-ink-500 sm:hidden">Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>
          {step === 0 && (<>
            <h2 className="font-display text-base font-semibold">Tell us a little about you</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="ob-name">Your name (optional)</label><input id="ob-name" className="input" value={a.name} onChange={(e) => set('name', e.target.value)} maxLength={100} autoComplete="name" autoFocus /></div>
              <div><label className="label" htmlFor="ob-email">E-mail (optional)</label><input id="ob-email" type="email" className="input" value={a.email} onChange={(e) => set('email', e.target.value)} maxLength={200} autoComplete="email" /><p className="hint">Only if you would like a reply or updates.</p></div>
            </div>
            <div><label className="label" htmlFor="ob-role">What do you do? (optional)</label><input id="ob-role" className="input" placeholder="Freelancer, agency, developer, creator ..." value={a.role} onChange={(e) => set('role', e.target.value)} maxLength={100} /></div>
          </>)}
          {step === 1 && (<>
            <h2 className="font-display text-base font-semibold">How will you use this platform?</h2>
            <Chips label="I want to (choose any)" options={USE_CASES} value={a.useCases} onToggle={toggle('useCases')} />
            <Chips label="Tools it will work with (optional)" options={TOOLS} value={a.tools} onToggle={toggle('tools')} />
          </>)}
          {step === 2 && (<>
            <h2 className="font-display text-base font-semibold">Your setup</h2>
            <Radios name="ob-volume" label="How much will you upload?" options={VOLUMES} value={a.volume} onPick={(v) => set('volume', v)} />
            <Radios name="ob-size" label="Typical file size" options={SIZES} value={a.fileSize} onPick={(v) => set('fileSize', v)} />
            <Radios name="ob-host" label="Where will it run?" options={HOSTING} value={a.hosting} onPick={(v) => set('hosting', v)} />
          </>)}
          {step === 3 && (<>
            <h2 className="font-display text-base font-semibold">Review and finish</h2>
            <dl className="divide-y divide-ink-100 rounded-lg border border-ink-100 text-sm">
              {([['Name', a.name], ['E-mail', a.email], ['Role', a.role], ['Use cases', a.useCases.join(', ')], ['Tools', a.tools.join(', ')], ['Uploads', a.volume], ['File size', a.fileSize], ['Runs on', a.hosting]] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex gap-4 px-3 py-2"><dt className="w-24 shrink-0 text-ink-500">{k}</dt><dd className="min-w-0 break-words">{v || <span className="text-ink-400">-</span>}</dd></div>))}
            </dl>
            <div><label className="label" htmlFor="ob-notes">Anything else? (optional)</label><textarea id="ob-notes" className="input min-h-[5rem]" value={a.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} /></div>
            <Notice>Submitting sends these answers to the developer of this app (via formsubmit.co, from your browser; the page does not reload). Do not include passwords or secrets. Your videos, files and API keys are never sent.</Notice>
          </>)}

          {(stepError || error) && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{stepError ?? error}</div>}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2">
              {step > 0 && <button type="button" className="btn-secondary" onClick={() => { setStepError(null); setStep((s) => s - 1); }} disabled={busy !== null}><ArrowLeft className="h-4 w-4" />Back</button>}
              <button type="button" className="btn-ghost" onClick={() => finish(true)} disabled={busy !== null}>{busy === 'skip' && <Loader2 className="h-4 w-4 animate-spin" />}Skip</button>
            </div>
            {step < STEPS.length - 1
              ? <button type="button" className="btn-primary" onClick={next}>Next<ArrowRight className="h-4 w-4" /></button>
              : <button type="button" className="btn-primary" onClick={() => finish(false)} disabled={busy !== null}>{busy === 'submit' && <Loader2 className="h-4 w-4 animate-spin" />}Submit and continue</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
