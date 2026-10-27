import fs from 'node:fs';
import { pipeline } from 'node:stream';
import type { Request, RequestHandler, Response } from 'express';
import type { Ctx } from './context';
import { errorBody } from './errors';
import { uploadPath } from './storage';
import { getVideo, type VideoRow } from './videos';
import type { MediaType } from './mediaTypes';
import { contentDisposition } from './util';

const FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.([a-z0-9]{1,10}))?$/;

type RangeResult = { start: number; end: number } | 'invalid' | null;
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return header.includes(',') ? null : null; // unsupported / multi-range -> ignore, send full file
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number, end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(size - suffix, 0); end = size - 1;
  } else {
    start = Number(a); end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size || start > end) return 'invalid';
  }
  return { start, end };
}

const matchesEtag = (header: string, etag: string) => header.split(',').some((t) => { const v = t.trim(); return v === '*' || v === etag || v === `W/${etag}`; });

function json(res: Response, status: number, code: string, message: string) {
  res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).status(status).json(errorBody(code, message));
}

const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const ACTIVE_EXTS = new Set(['html', 'htm', 'xhtml', 'js', 'mjs', 'php', 'xml', 'xsl', 'xslt', 'svg', 'swf', 'hta', 'css']);

/** How a stored item is delivered publicly. Active content (HTML, JS, PHP, XML, SVG ...) is never rendered as an executable document. */
function deliveryPolicy(row: VideoRow): { type: string; inline: boolean; csp?: string } {
  if (row.media_type === 'video') return { type: row.mime_type, inline: true };
  if (row.media_type === 'image') return { type: row.mime_type, inline: true, csp: SANDBOX_CSP };
  const ext = row.extension, cat = row.category;
  if (cat === 'code' || ACTIVE_EXTS.has(ext)) return { type: 'application/octet-stream', inline: false, csp: SANDBOX_CSP };
  if (ext === 'pdf') return { type: 'application/pdf', inline: true };
  if (cat === 'audio') return { type: row.mime_type, inline: true, csp: SANDBOX_CSP };
  if (['txt', 'md', 'csv', 'tsv'].includes(ext)) return { type: 'text/plain; charset=utf-8', inline: true, csp: SANDBOX_CSP };
  if (ext === 'json') return { type: 'application/json', inline: true, csp: SANDBOX_CSP };
  return { type: row.mime_type, inline: false, csp: SANDBOX_CSP };
}

export function publicVideoHandler(ctx: Ctx, kind: MediaType = 'video'): RequestHandler {
  return (req: Request, res: Response) => {
    const m = FILE_RE.exec(String(req.params.file ?? '').toLowerCase());
    if (!m) return json(res, 404, 'not_found', 'Video not found.');
    const row = getVideo(ctx, m[1]);
    if (!row || row.media_type !== kind || (m[2] && m[2] !== row.extension)) return json(res, 404, 'not_found', 'Video not found.');
    if (row.status !== 'active') return json(res, 410, 'gone', 'This video is no longer available.');

    let stat: fs.Stats;
    try { stat = fs.statSync(uploadPath(ctx, row.storage_name)); }
    catch {
      ctx.audit('storage_error', { metadata: { op: 'serve', videoId: row.id, error: 'physical file missing' } });
      return json(res, 404, 'not_found', 'Video not found.');
    }
    const size = stat.size;
    const etag = `"${row.sha256}"`;
    const lastModified = new Date(row.created_at);
    const download = req.query.download === '1' || req.query.download === 'true';

    const policy = deliveryPolicy(row);
    res.set({
      'Content-Type': policy.type,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified.toUTCString(),
      'Cache-Control': 'public, max-age=300, must-revalidate',
      'Content-Disposition': contentDisposition(download || !policy.inline ? 'attachment' : 'inline', row.original_name),
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    });

    if (policy.csp) res.set('Content-Security-Policy', policy.csp);

    // Conditional requests
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if (inm ? matchesEtag(inm, etag) : ims && Date.parse(ims) >= Math.floor(lastModified.getTime() / 1000) * 1000) {
      return void res.status(304).end();
    }

    // Range handling (If-Range must match the validator or the range is ignored)
    let range = parseRange(req.headers.range, size);
    const ifRange = req.headers['if-range'] as string | undefined;
    if (range && ifRange && ifRange !== etag && Date.parse(ifRange) !== Math.floor(lastModified.getTime() / 1000) * 1000) range = null;
    if (range === 'invalid') {
      res.set('Content-Range', `bytes */${size}`);
      return void res.status(416).end();
    }

    let status = 200, start = 0, end = size - 1;
    if (range) { status = 206; start = range.start; end = range.end; res.set('Content-Range', `bytes ${start}-${end}/${size}`); }
    res.status(status).set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return void res.end();

    const stream = fs.createReadStream(uploadPath(ctx, row.storage_name), { start, end });
    pipeline(stream, res, (err) => {
      if (err && !res.writableEnded && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        ctx.log.warn('Error while streaming video', { videoId: row.id, error: err.message });
        res.destroy();
      }
    });
  };
}
