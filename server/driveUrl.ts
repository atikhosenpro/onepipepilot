/** Strict parsing of Google Drive links / IDs. Only the extracted File ID is ever used: the link itself is NEVER fetched. */
export class DriveUrlError extends Error {
  constructor(public code: 'invalid' | 'folder' | 'unsupported', message: string) { super(message); }
}
export interface DriveSource { fileId: string; hint: 'file' | 'document' | 'spreadsheet' | 'presentation' | 'drawing' | 'id' }

export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const HOSTS = new Set(['drive.google.com', 'docs.google.com']);

export function parseDriveSource(input: unknown): DriveSource {
  if (typeof input !== 'string' || !input.trim()) throw new DriveUrlError('invalid', 'No Google Drive link or file ID was provided.');
  const raw = input.trim();
  if (raw.length > 2048) throw new DriveUrlError('invalid', 'The Google Drive link is too long.');
  if (!/[/:.?=]/.test(raw)) {
    if (DRIVE_ID_RE.test(raw)) return { fileId: raw, hint: 'id' };
    throw new DriveUrlError('invalid', 'That is not a valid Google Drive file ID.');
  }
  let u: URL;
  try { u = new URL(raw); } catch { throw new DriveUrlError('invalid', 'That is not a valid Google Drive link (expected https://drive.google.com/file/d/FILE_ID/view).'); }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) {
    throw new DriveUrlError('invalid', 'Only https://drive.google.com and https://docs.google.com links are accepted.');
  }
  const path = u.pathname.replace(/^\/(?:a\/[^/]+\/)?(?:u\/\d+\/)?/, '/').replace(/^\/drive(?:\/u\/\d+)?\//, '/drive/');
  const ok = (id: string | null | undefined, hint: DriveSource['hint']): DriveSource => {
    if (id && DRIVE_ID_RE.test(id)) return { fileId: id, hint };
    throw new DriveUrlError('invalid', 'The link does not contain a valid Google Drive file ID.');
  };
  let m = /^\/file\/d\/([^/]+)(?:\/|$)/.exec(path);
  if (m) return ok(m[1], 'file');
  m = /^\/(document|spreadsheets|presentation|drawings)\/d\/([^/]+)(?:\/|$)/.exec(path);
  if (m) return ok(m[2], ({ document: 'document', spreadsheets: 'spreadsheet', presentation: 'presentation', drawings: 'drawing' } as const)[m[1] as 'document']);
  if (/^\/forms\//.test(path)) throw new DriveUrlError('unsupported', 'Google Forms cannot be imported.');
  if (/^\/drive\/(?:folders|shared-drives)\b/.test(path) || /^\/folderview\b/.test(path)) throw new DriveUrlError('folder', 'That link points to a folder. Link to a single file instead.');
  if (/^\/(?:open|uc)$/.test(path)) return ok(u.searchParams.get('id'), 'file');
  throw new DriveUrlError('invalid', 'Unsupported Google Drive link format. Use a file link such as https://drive.google.com/file/d/FILE_ID/view.');
}
