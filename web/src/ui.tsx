import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from './api';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X, XCircle } from 'lucide-react';

// ---------- toasts ----------
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-ink-200 bg-white p-3 text-sm shadow-lg">
            {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-reel-600" /> : t.kind === 'error' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />}
            <span className="min-w-0 break-words">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- layout bits ----------
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink-950">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 p-10 text-sm text-ink-500"><Loader2 className="h-4 w-4 animate-spin" />{label ?? 'Loading...'}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">{message}</div>
      {onRetry && <button className="btn-secondary btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode }) {
  const cls = tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : tone === 'ok' ? 'border-reel-200 bg-reel-50 text-reel-900' : 'border-ink-200 bg-ink-50 text-ink-700';
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info;
  return <div className={`flex items-start gap-2.5 rounded-lg border p-3 text-sm ${cls}`}><Icon className="mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0">{children}</div></div>;
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'error' | 'neutral'; children: ReactNode }) {
  const cls = { ok: 'bg-reel-50 text-reel-800 ring-reel-200', warn: 'bg-amber-50 text-amber-800 ring-amber-200', error: 'bg-red-50 text-red-700 ring-red-200', neutral: 'bg-ink-100 text-ink-700 ring-ink-200' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>{children}</span>;
}

export function Empty({ title, text }: { title: string; text?: string }) {
  return <div className="px-6 py-14 text-center"><p className="font-medium text-ink-700">{title}</p>{text && <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">{text}</p>}</div>;
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-ink-100 px-4 py-3 text-sm text-ink-600">
      <span>{total.toLocaleString()} total</span>
      <div className="flex items-center gap-2">
        <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
        <span>Page {page} of {totalPages}</span>
        <button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ---------- modal / confirm ----------
export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`card max-h-[90vh] w-full overflow-auto ${wide ? 'max-w-3xl' : 'max-w-md'} outline-none`}>
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3.5">
          <h2 className="font-display text-base font-semibold">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger, requireText, onConfirm, onClose }: {
  title: string; message: ReactNode; confirmLabel: string; danger?: boolean; requireText?: string; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const ok = !requireText || typed === requireText;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4 text-sm text-ink-700">
        <div>{message}</div>
        {requireText && (
          <div>
            <label className="label" htmlFor="confirm-text">Type <span className="font-mono font-semibold">{requireText}</span> to confirm</label>
            <input id="confirm-text" className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={!ok || busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return <div><label className="label" htmlFor={htmlFor}>{label}</label>{children}{hint && <p className="hint">{hint}</p>}</div>;
}

export function CopyButton({ text, label = 'Copy', done = 'Copied to clipboard', className = 'btn-secondary btn-sm' }: { text: string; label?: string; done?: string; className?: string }) {
  const toast = useToast();
  return (
    <button className={className} onClick={async () => { const ok = await copyText(text); toast(ok ? 'success' : 'error', ok ? done : 'Could not copy - select and copy manually.'); }}>
      {label}
    </button>
  );
}
