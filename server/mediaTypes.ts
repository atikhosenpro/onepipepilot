/** Shared helpers for the three libraries (video / image / file). Pure functions, no I/O. */
export type MediaType = 'video' | 'image' | 'file';
export const MEDIA_TYPES: MediaType[] = ['video', 'image', 'file'];

export const URL_PREFIX: Record<MediaType, string> = { video: '/videos', image: '/images', file: '/files' };

export const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mpeg: 'video/mpeg', mpg: 'video/mpeg', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', '3gp': 'video/3gpp', ts: 'video/mp2t', mts: 'video/mp2t',
};
export const VIDEO_EXTS = Object.keys(VIDEO_MIME);

export const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
  jxl: 'image/jxl', jp2: 'image/jp2', psd: 'image/vnd.adobe.photoshop', tga: 'image/x-tga', dng: 'image/x-adobe-dng',
};
/** Image extensions that are stored even when the built-in analyser cannot read them. */
export const IMAGE_EXTRA_EXTS = ['heic', 'heif', 'jxl', 'jp2', 'psd', 'tga', 'dng'];

const FILE_MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml',
  yaml: 'application/yaml', yml: 'application/yaml', sql: 'application/sql',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', php: 'application/x-httpd-php', py: 'text/x-python', sh: 'application/x-sh',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip', tgz: 'application/gzip', bz2: 'application/x-bzip2', xz: 'application/x-xz',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma', opus: 'audio/opus', aiff: 'audio/aiff', aif: 'audio/aiff', mid: 'audio/midi', midi: 'audio/midi',
  ...Object.fromEntries(Object.entries(VIDEO_MIME).filter(([e]) => e !== 'ts')), ...IMAGE_MIME,
};
export function mimeForFileExt(ext: string): string { return FILE_MIME[ext] ?? 'application/octet-stream'; }

export type FileCategory = 'document' | 'archive' | 'code' | 'audio' | 'data' | 'other';
const CATEGORY_EXTS: Record<Exclude<FileCategory, 'other'>, string[]> = {
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso'],
  code: ['html', 'htm', 'css', 'js', 'mjs', 'php', 'py', 'sh', 'ts', 'tsx', 'jsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rb', 'rs', 'bat', 'ps1'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'wma', 'opus', 'aiff', 'aif', 'mid', 'midi'],
  data: ['csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'sql', 'db', 'sqlite'],
};
export function fileCategory(ext: string): FileCategory {
  for (const [cat, exts] of Object.entries(CATEGORY_EXTS)) if (exts.includes(ext)) return cat as FileCategory;
  return 'other';
}
export const FILE_CATEGORIES: FileCategory[] = ['document', 'archive', 'code', 'audio', 'data', 'other'];

/** Lower-case extension made only of [a-z0-9] (max 10), or '' when the name has no usable extension. */
export function safeExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
export const round2 = (n: number) => round(n, 2);
export const round3 = (n: number) => round(n, 3);
export const round4 = (n: number) => round(n, 4);

const COMMON_RATIOS: [string, number][] = [
  ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:5', 4 / 5], ['5:4', 5 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3],
  ['21:9', 21 / 9], ['9:21', 9 / 21], ['2:1', 2], ['1:2', 0.5], ['16:10', 1.6], ['10:16', 0.625],
];
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Normalised aspect ratio label ("16:9") plus the exact numeric value (width / height). */
export function aspectOf(width: number | null | undefined, height: number | null | undefined): { label: string; value: number } | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const v = width / height;
  for (const [label, val] of COMMON_RATIOS) if (Math.abs(v / val - 1) < 0.01) return { label, value: round4(v) };
  const g = gcd(width, height);
  const a = width / g, b = height / g;
  const label = a <= 32 && b <= 32 ? `${a}:${b}` : v >= 1 ? `${v.toFixed(2)}:1` : `1:${(1 / v).toFixed(2)}`;
  return { label, value: round4(v) };
}

/** Parse "9:16", "9/16", "9x16" or a decimal such as "0.5625" into a numeric width/height value. */
export function parseAspectQuery(input: string): number | null {
  const s = input.trim();
  const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i.exec(s);
  if (m) { const a = Number(m[1]), b = Number(m[2]); return b > 0 && a > 0 ? a / b : null; }
  if (/^\d+(?:\.\d+)?$/.test(s) && Number(s) > 0) return Number(s);
  return null;
}

export function orientationOf(width: number | null | undefined, height: number | null | undefined): 'landscape' | 'portrait' | 'square' | null {
  if (!width || !height) return null;
  const v = width / height;
  return Math.abs(v - 1) <= 0.01 ? 'square' : v > 1 ? 'landscape' : 'portrait';
}

/** Resolution class from the shorter side, so 1920x1080 and 1080x1920 are both "1080p". */
export function resolutionCategoryOf(width: number | null | undefined, height: number | null | undefined): string | null {
  if (!width || !height) return null;
  const s = Math.min(width, height);
  if (s >= 2160) return '4K';
  if (s >= 1440) return '1440p';
  if (s >= 1080) return '1080p';
  if (s >= 720) return '720p';
  if (s >= 480) return '480p';
  if (s >= 360) return '360p';
  if (s >= 240) return '240p';
  return 'below-240p';
}
export const RESOLUTION_CATEGORIES = ['4K', '1440p', '1080p', '720p', '480p', '360p', '240p', 'below-240p'];

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function humanSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
