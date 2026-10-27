import { useState, type FormEvent } from 'react';
import { api, setCsrf } from '../api';
import { useApp } from '../App';
import { Field, Notice, PageHeader, useToast } from '../ui';

export default function Account() {
  const { session, refresh } = useApp();
  const toast = useToast();
  const [cur, setCur] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pw !== pw2) { setErr('The new passwords do not match.'); return; }
    try {
      const r = await api<{ csrfToken: string; sessionsInvalidated: number }>('/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: pw } });
      setCsrf(r.csrfToken); setCur(''); setPw(''); setPw2('');
      toast('success', 'Password changed. All other sessions were signed out.'); await refresh();
    } catch (e2) { setErr((e2 as Error).message); }
  };
  const revokeOthers = async () => { try { const r = await api<{ revoked: number }>('/sessions/revoke-others', { method: 'POST' }); toast('success', `Signed out ${r.revoked} other session(s).`); } catch (e) { toast('error', (e as Error).message); } };
  return (
    <>
      <PageHeader title="Account" subtitle={<>Signed in as <strong>{session.username}</strong>.</>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={submit} className="card space-y-4 p-5">
          <h2 className="font-display text-base font-semibold">Change password</h2>
          <Field label="Current password" htmlFor="cur"><input id="cur" type="password" className="input" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required /></Field>
          <Field label="New password" htmlFor="pw" hint="At least 12 characters, with letters and digits."><input id="pw" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required /></Field>
          <Field label="Confirm new password" htmlFor="pw2"><input id="pw2" type="password" className="input" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required /></Field>
          {err && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
          <button className="btn-primary">Update password</button>
        </form>
        <div className="card space-y-3 p-5">
          <h2 className="font-display text-base font-semibold">Sessions</h2>
          <p className="text-sm text-ink-600">Changing your password signs out every other browser. You can also do that on demand if you used a shared computer.</p>
          <button className="btn-secondary" onClick={revokeOthers}>Sign out all other sessions</button>
          <Notice>Sessions expire after 8 hours without activity, or 7 days at most.</Notice>
        </div>
      </div>
    </>
  );
}
