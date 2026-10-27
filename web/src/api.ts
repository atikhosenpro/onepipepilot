export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

let csrfToken: string | null = null;
export const setCsrf = (t: string | null) => { csrfToken = t; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, { method, headers, credentials: 'same-origin', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Is the app still running?');
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  return data as T;
}

export interface Settings {
  publicBaseUrl: string; maxUploadBytes: number; allowedTypes: string[]; fieldName: string; uploadRetentionDays: number; trashRetentionDays: number;
  storageWarnFreeBytes: number; auditRetentionDays: number; logLevel: 'debug' | 'info' | 'warn' | 'error'; timeZone: string; timeFormat: '12h' | '24h';
  shortVideoMaxSeconds: number; metadataTimeoutSeconds: number;
}
export type MediaKind = 'video' | 'image' | 'file';
export interface VideoItem {
  id: string; originalName: string; mimeType: string; extension: string; size: number; sha256: string; status: 'active' | 'trashed';
  createdAt: string; updatedAt: string; trashedAt: string | null; publicUrl: string | null; downloadUrl: string | null;
  mediaType: MediaKind; sizeFormatted: string; metadataStatus: 'pending' | 'processing' | 'ready' | 'unavailable' | 'failed'; metadataSource: string | null; metadataError: string | null;
  // video / image
  width?: number | null; height?: number | null; resolution?: string | null; aspectRatio?: string | null; aspectRatioValue?: number | null; orientation?: string | null;
  // video
  durationSeconds?: number | null; durationFormatted?: string | null; durationMinutes?: number | null; resolutionCategory?: string | null; frameRate?: number | null;
  videoCodec?: string | null; audioCodec?: string | null; videoClass?: 'short' | 'long' | null; isShort?: boolean | null;
  // image
  imageFormat?: string | null; hasAlpha?: boolean | null; colorSpace?: string | null;
  // file
  category?: string | null;
}
export const itemUrl = (v: Pick<VideoItem, 'id' | 'extension' | 'mediaType'>, download = false) =>
  `/${v.mediaType === 'image' ? 'images' : v.mediaType === 'file' ? 'files' : 'videos'}/${v.id}.${v.extension}${download ? '?download=1' : ''}`;
export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number }

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDate(iso: string | null | undefined, s?: Pick<Settings, 'timeZone' | 'timeFormat'> | null): string {
  if (!iso) return '-';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: s?.timeZone, dateStyle: 'medium', timeStyle: 'medium', hourCycle: s?.timeFormat === '12h' ? 'h12' : 'h23' }).format(new Date(iso));
  } catch { return iso; }
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { return document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  }
}
