import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { api, setCsrf } from '../api';
import { Field, Notice } from '../ui';

export function AuthScreen({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => Promise<void> }) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setupRequired && password !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      const r = await api<{ csrfToken: string }>(setupRequired ? '/setup' : '/login', { method: 'POST', body: setupRequired ? { token, username, password } : { username, password } });
      setCsrf(r.csrfToken);
      await onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <div className="hidden flex-col justify-between bg-ink-900 p-12 text-ink-200 lg:flex">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-reel-600 text-white"><svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden><path d="M12 9l11 7-11 7z" fill="currentColor" /></svg></div>
          <span className="font-display text-lg font-semibold text-white">Local Video Host</span>
        </div>
        <div>
          <p className="font-display text-4xl font-semibold leading-tight text-white">Your videos, on your disk,<br />one link each.</p>
          <p className="mt-5 max-w-md text-ink-300">Send a file from n8n or any HTTP client, get back a direct URL that Buffer, YouTube workflows and browsers can fetch. Nothing leaves your computer unless you expose it.</p>
        </div>
        <p className="text-sm text-ink-400">Uploads need an API key. The dashboard needs your admin login.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="font-display text-2xl font-semibold text-ink-950">{setupRequired ? 'Create the admin account' : 'Sign in'}</h1>
            <p className="mt-1 text-sm text-ink-500">{setupRequired ? 'First-time setup. Choose your own username and password.' : 'Enter your administrator credentials.'}</p>
          </div>
          {setupRequired && (
            <>
              <Notice>The setup token was printed in the terminal where you started the app. It is also saved in <span className="font-mono">data/setup-token.txt</span>. It works once.</Notice>
              <Field label="Setup token" htmlFor="token"><input id="token" className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required /></Field>
            </>
          )}
          <Field label="Username" htmlFor="username" hint={setupRequired ? '3-32 characters: letters, digits, ".", "_" or "-".' : undefined}>
            <input id="username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
          </Field>
          <Field label="Password" htmlFor="password" hint={setupRequired ? 'At least 12 characters, with letters and digits.' : undefined}>
            <input id="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} required />
          </Field>
          {setupRequired && <Field label="Confirm password" htmlFor="confirm"><input id="confirm" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required /></Field>}
          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
          <button className="btn-primary w-full" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{setupRequired ? 'Create account' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}
