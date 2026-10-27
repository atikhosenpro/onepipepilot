import crypto from 'node:crypto';

export const sha256Hex = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');
export const nowIso = (): string => new Date().toISOString();

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Reduce a client-supplied filename to a safe display string (never used as a storage key). */
export function sanitizeFilename(input: unknown): string {
  let name = typeof input === 'string' ? input : '';
  name = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_');
  name = name.replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name || 'video';
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'video';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** UTC instant of local midnight "today" in the given IANA time zone. */
export function startOfTodayUtc(timeZone: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - offset);
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function tzOffsetMs(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant / 1000) * 1000;
}

/** UTC instant of local midnight at the start of the given calendar day in an IANA time zone. */
export function zonedDayStartUtc(timeZone: string, year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - tzOffsetMs(timeZone, guess);
  t = guess - tzOffsetMs(timeZone, t);
  return new Date(t);
}
