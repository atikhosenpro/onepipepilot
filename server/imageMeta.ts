/** Header-only image analysis (JPEG, PNG, GIF, WebP, BMP, TIFF, ICO, SVG, AVIF/HEIC). No decoding, no native dependencies. */
import fs from 'node:fs';
import { sniffImage } from './sniff';

export interface ImageMeta { width: number | null; height: number | null; format: string; hasAlpha: boolean | null; colorSpace: string | null }
const HEAD = 2 * 1024 * 1024;

function exifOrientation(b: Buffer, start: number, end: number): number {
  if (end - start < 14 || b.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1;
  const t = start + 6;
  const le = b.toString('latin1', t, t + 2) === 'II';
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= end; i++) {
    const e = ifd + 2 + i * 12;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return 1;
}

function jpeg(b: Buffer): ImageMeta | null {
  let pos = 2, orient = 1;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) { pos++; continue; }
    const m = b[pos + 1];
    if (m === 0xff) { pos++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    const len = b.readUInt16BE(pos + 2);
    if (m === 0xe1) orient = exifOrientation(b, pos + 4, Math.min(pos + 2 + len, b.length));
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (pos + 10 > b.length) return null;
      let h = b.readUInt16BE(pos + 5), w = b.readUInt16BE(pos + 7);
      const comps = b[pos + 9];
      if (orient >= 5 && orient <= 8) [w, h] = [h, w];
      return { width: w, height: h, format: 'JPEG', hasAlpha: false, colorSpace: comps === 1 ? 'grayscale' : comps === 4 ? 'cmyk' : 'rgb' };
    }
    if (m === 0xda) return null;
    pos += 2 + len;
  }
  return null;
}

function png(b: Buffer): ImageMeta | null {
  if (b.length < 33) return null;
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), ct = b[25];
  let trns = false, srgb = false, pos = 8;
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('latin1', pos + 4, pos + 8);
    if (type === 'tRNS') trns = true; else if (type === 'sRGB') srgb = true; else if (type === 'IDAT') break;
    pos += 12 + len;
  }
  const colorSpace = ct === 0 || ct === 4 ? 'grayscale' : ct === 3 ? 'indexed' : srgb ? 'srgb' : 'rgb';
  return { width: w, height: h, format: 'PNG', hasAlpha: ct === 4 || ct === 6 || trns, colorSpace };
}

function gif(b: Buffer, fileSize: number): ImageMeta | null {
  if (b.length < 10) return null;
  let alpha: boolean | null = null;
  for (let i = 13; i + 8 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 4) { if (b[i + 3] & 1) { alpha = true; break; } }
  if (alpha == null && fileSize <= b.length) alpha = false;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: 'GIF', hasAlpha: alpha, colorSpace: 'indexed' };
}

function webp(b: Buffer): ImageMeta | null {
  if (b.length < 30) return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'WebP', hasAlpha: false, colorSpace: 'rgb' };
  if (kind === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: 'WebP', hasAlpha: ((bits >>> 28) & 1) === 1, colorSpace: 'rgb' }; }
  if (kind === 'VP8X') return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1, format: 'WebP', hasAlpha: (b[20] & 0x10) !== 0, colorSpace: 'rgb' };
  return null;
}

function bmp(b: Buffer): ImageMeta | null {
  const bpp = b.readUInt16LE(28);
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)), format: 'BMP', hasAlpha: bpp === 32 ? null : false, colorSpace: bpp <= 8 ? 'indexed' : 'rgb' };
}

function tiff(b: Buffer): ImageMeta | null {
  const le = b[0] === 0x49;
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > b.length) return null;
  const n = u16(ifd);
  const t: Record<number, number> = {};
  for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= b.length; i++) {
    const e = ifd + 2 + i * 12, type = u16(e + 2);
    t[u16(e)] = type === 3 ? u16(e + 8) : u32(e + 8);
  }
  if (!t[256] || !t[257]) return null;
  const photo = t[262], spp = t[277] ?? 1;
  const colorSpace = photo === 0 || photo === 1 ? 'grayscale' : photo === 3 ? 'indexed' : photo === 5 ? 'cmyk' : photo === 6 ? 'ycbcr' : 'rgb';
  return { width: t[256], height: t[257], format: 'TIFF', hasAlpha: t[338] !== undefined ? t[338] > 0 : spp === 4 && photo === 2 ? true : false, colorSpace };
}

function ico(b: Buffer): ImageMeta | null {
  const n = b.readUInt16LE(4);
  let best: { w: number; h: number; bits: number } | null = null;
  for (let i = 0; i < n && 6 + i * 16 + 16 <= b.length; i++) {
    const o = 6 + i * 16, w = b[o] || 256, h = b[o + 1] || 256, bits = b.readUInt16LE(o + 6);
    if (!best || w * h > best.w * best.h) best = { w, h, bits };
  }
  return best ? { width: best.w, height: best.h, format: 'ICO', hasAlpha: best.bits === 32 ? true : null, colorSpace: null } : null;
}

function svg(b: Buffer): ImageMeta {
  const text = b.toString('utf8', 0, Math.min(b.length, 64 * 1024));
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];
  const num = (v?: string) => { const m = v ? /^\s*(\d+(?:\.\d+)?)\s*(px|pt)?\s*$/i.exec(v) : null; return m ? Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'pt' ? 4 / 3 : 1)) : null; };
  let w = num(attr('width')), h = num(attr('height'));
  if (!w || !h) {
    const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = w ?? Math.round(vb[2]); h = h ?? Math.round(vb[3]); if (!num(attr('width')) && !num(attr('height'))) { w = Math.round(vb[2]); h = Math.round(vb[3]); } }
  }
  return { width: w || null, height: h || null, format: 'SVG', hasAlpha: true, colorSpace: null };
}

function heif(b: Buffer, format: string): ImageMeta | null {
  let best: { w: number; h: number } | null = null;
  for (let i = b.indexOf('ispe', 0, 'latin1'); i >= 0 && i + 16 <= b.length; i = b.indexOf('ispe', i + 4, 'latin1')) {
    const w = b.readUInt32BE(i + 8), h = b.readUInt32BE(i + 12);
    if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w, h };
  }
  if (!best) return null;
  let { w, h } = best;
  const irot = b.indexOf('irot', 0, 'latin1');
  if (irot >= 4 && irot + 5 <= b.length && (b[irot + 4] & 3) % 2 === 1) [w, h] = [h, w];
  const alpha = b.includes('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha') || b.includes('urn:mpeg:hevc:2015:auxid:1');
  return { width: w, height: h, format, hasAlpha: alpha, colorSpace: null };
}

export async function readImageMeta(file: string): Promise<ImageMeta | null> {
  const fh = await fs.promises.open(file, 'r');
  let head: Buffer, size: number;
  try {
    size = (await fh.stat()).size;
    head = Buffer.alloc(Math.min(size, HEAD));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    head = head.subarray(0, bytesRead);
  } finally { await fh.close(); }
  const s = sniffImage(head);
  if (!s) return null;
  switch (s.ext) {
    case 'jpg': return jpeg(head);
    case 'png': return png(head);
    case 'gif': return gif(head, size);
    case 'webp': return webp(head);
    case 'bmp': return bmp(head);
    case 'tiff': return tiff(head);
    case 'ico': return ico(head);
    case 'svg': return svg(head);
    case 'avif': case 'heic': return heif(head, s.format);
    default: return null;
  }
}
