import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Activity, BookOpen, Cloud, FileText, Film, HardDrive, Image as ImageIcon, KeyRound, LayoutDashboard, LogOut, Menu, Settings as SettingsIcon, ShieldCheck, Stethoscope, Trash2, X } from 'lucide-react';
import { api, setCsrf, type Settings } from './api';
import { Spinner, ErrorBox, useToast } from './ui';
import { AuthScreen } from './pages/Auth';
import { Onboarding, markOnboarded, wasOnboarded } from './pages/Onboarding';
import Overview from './pages/Overview';
import Videos from './pages/Videos';
import Storage from './pages/Storage';
import ApiKeys from './pages/ApiKeys';
import Logs from './pages/Logs';
import SettingsPage from './pages/SettingsPage';
import ApiDocs from './pages/ApiDocs';
import System from './pages/System';
import Account from './pages/Account';
import Drive from './pages/Drive';

interface SessionState { onboardingDone?: boolean; setupRequired: boolean; authenticated: boolean; username: string | null; version: string; settings: Settings | null }
interface AppCtx { session: SessionState; refresh: () => Promise<void>; settings: Settings | null; setSettings: (s: Settings) => void }
const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/videos', label: 'Video library', icon: Film },
  { to: '/images', label: 'Image library', icon: ImageIcon },
  { to: '/files', label: 'File library', icon: FileText },
  { to: '/drive', label: 'Google Drive', icon: Cloud },
  { to: '/trash', label: 'Trash', icon: Trash2 },
  { to: '/storage', label: 'Storage', icon: HardDrive },
  { to: '/api-keys', label: 'API keys', icon: KeyRound },
  { to: '/logs', label: 'Activity logs', icon: Activity },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/docs', label: 'API docs', icon: BookOpen },
  { to: '/system', label: 'System', icon: Stethoscope },
  { to: '/account', label: 'Account', icon: ShieldCheck },
];

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<SessionState & { csrfToken: string | null }>('/session');
      setCsrf(s.csrfToken);
      setSession(s);
      setSettings(s.settings);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <div className="mx-auto max-w-md p-8"><ErrorBox message={error} onRetry={refresh} /></div>;
  if (!session) return <Spinner />;
  // Signed-in users (and anyone who already finished or skipped it) never see onboarding again.
  if (session.authenticated || session.onboardingDone) markOnboarded();
  if (!session.authenticated && !session.onboardingDone && !wasOnboarded()) return <Onboarding onDone={refresh} />;
  if (session.setupRequired || !session.authenticated) return <AuthScreen setupRequired={session.setupRequired} onDone={refresh} />;

  return (
    <Ctx.Provider value={{ session, refresh, settings, setSettings }}>
      <Shell />
    </Ctx.Provider>
  );
}

function Shell() {
  const { session, refresh } = useApp();
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const logout = async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
    setCsrf(null);
    await refresh();
    navigate('/');
    toast('info', 'Signed out.');
  };

  const sidebar = (
    <nav className="flex h-full flex-col bg-ink-900 text-ink-200" aria-label="Main">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-reel-600 text-white"><svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden><path d="M12 9l11 7-11 7z" fill="currentColor" /></svg></div>
        <div className="leading-tight"><div className="font-display text-[15px] font-semibold text-white">OnePipePilot</div><div className="text-xs text-ink-400">v{session.version}</div></div>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
            className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${isActive ? 'bg-ink-700/70 font-medium text-white' : 'text-ink-300 hover:bg-ink-800 hover:text-white'}`}>
            <n.icon className="h-4 w-4 shrink-0" />{n.label}
          </NavLink>
        ))}
      </div>
      <div className="border-t border-ink-800 p-3">
        <div className="mb-2 truncate px-2 text-xs text-ink-400">Signed in as <span className="font-medium text-ink-200">{session.username}</span></div>
        <button onClick={logout} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 hover:text-white"><LogOut className="h-4 w-4" />Sign out</button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-ink-100 bg-white px-4 py-3 lg:hidden">
          <button className="btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation">{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
          <span className="font-display font-semibold">OnePipePilot</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/videos" element={<Videos mode="active" kind="video" />} />
              <Route path="/images" element={<Videos mode="active" kind="image" />} />
              <Route path="/files" element={<Videos mode="active" kind="file" />} />
              <Route path="/drive" element={<Drive />} />
              <Route path="/trash" element={<Videos mode="trashed" />} />
              <Route path="/storage" element={<Storage />} />
              <Route path="/api-keys" element={<ApiKeys />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/docs" element={<ApiDocs />} />
              <Route path="/system" element={<System />} />
              <Route path="/account" element={<Account />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}
