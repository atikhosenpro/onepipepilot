/** Detect media containers from the first bytes of a file (never trusts extension or client MIME). */
import { IMAGE_MIME, VIDEO_MIME } from './mediaTypes';

export interface Sniffed { ext: string; mime: string; /** extensions that are consistent with the detected content */ group: string[] }
export const MIME_BY_EXT: Record<string, string> = VIDEO_MIME;

const ISO_GROUP = ['mp4', 'm4v', 'mov', '3gp'];
const IMAGE_BRANDS = ['avif', 'avis', 'heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'];

export function looksLikeText(head: Buffer): boolean {
  const n = Math.min(head.length, 1024);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = head[i];
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  }
  return printable / n > 0.95;
}

export function sniffVideo(head: Buffer): Sniffed | null {
  // Matroska / WebM: EBML header 1A 45 DF A3, DocType in the first bytes.
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const text = head.subarray(0, Math.min(head.length, 64)).toString('latin1');
    if (text.includes('webm')) return { ext: 'webm', mime: VIDEO_MIME.webm, group: ['webm', 'mkv'] };
    if (text.includes('matroska')) return { ext: 'mkv', mime: VIDEO_MIME.mkv, group: ['mkv', 'webm'] };
    return null;
  }
  // ISO base media (MP4 / M4V / MOV / 3GP)
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const size = head.readUInt32BE(0);
    if (size !== 1 && (size < 16 || size > 4096)) return null;
    const brand = head.toString('latin1', 8, 12);
    if (!/^[\x20-\x7e]{4}$/.test(brand) || IMAGE_BRANDS.includes(brand)) return null;
    if (brand === 'qt  ') return { ext: 'mov', mime: VIDEO_MIME.mov, group: ISO_GROUP };
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return { ext: 'm4v', mime: VIDEO_MIME.m4v, group: ISO_GROUP };
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return { ext: '3gp', mime: VIDEO_MIME['3gp'], group: ISO_GROUP };
    return { ext: 'mp4', mime: VIDEO_MIME.mp4, group: ISO_GROUP };
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'AVI ') return { ext: 'avi', mime: VIDEO_MIME.avi, group: ['avi'] };
  if (head.length >= 4 && head[0] === 0 && head[1] === 0 && head[2] === 1 && (head[3] === 0xba || head[3] === 0xb3)) return { ext: 'mpg', mime: VIDEO_MIME.mpg, group: ['mpg', 'mpeg'] };
  if (head.length >= 8 && head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75 && head[4] === 0x8e && head[5] === 0x66 && head[6] === 0xcf && head[7] === 0x11) return { ext: 'wmv', mime: VIDEO_MIME.wmv, group: ['wmv'] };
  if (head.length >= 4 && head.toString('latin1', 0, 3) === 'FLV' && head[3] === 1) return { ext: 'flv', mime: VIDEO_MIME.flv, group: ['flv'] };
  if (head.length >= 377 && head[0] === 0x47 && head[188] === 0x47 && head[376] === 0x47) return { ext: 'ts', mime: VIDEO_MIME.ts, group: ['ts', 'mts', 'm2ts'] };
  if (head.length >= 389 && head[4] === 0x47 && head[196] === 0x47 && head[388] === 0x47) return { ext: 'mts', mime: VIDEO_MIME.mts, group: ['mts', 'm2ts', 'ts'] };
  return null;
}

export function extensionCompatible(declaredExt: string, sniffed: Sniffed): boolean {
  if (!declaredExt) return true;
  return sniffed.group.includes(declaredExt.toLowerCase());
}

export interface SniffedImage extends Sniffed { format: string }

export function sniffImage(head: Buffer): SniffedImage | null {
  const mk = (ext: string, group: string[] = [ext], format = ext.toUpperCase()): SniffedImage => ({ ext, mime: IMAGE_MIME[ext], group, format });
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return mk('jpg', ['jpg', 'jpeg', 'jfif'], 'JPEG');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return mk('png', ['png', 'apng'], 'PNG');
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return mk('gif', ['gif'], 'GIF');
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return mk('webp', ['webp'], 'WebP');
  if (head.length >= 26 && head[0] === 0x42 && head[1] === 0x4d && head.readUInt32LE(14) >= 12 && head.readUInt32LE(14) <= 256) return mk('bmp', ['bmp'], 'BMP');
  if (head.length >= 8 && ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a))) return mk('tiff', ['tif', 'tiff'], 'TIFF');
  if (head.length >= 22 && head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0 && head.readUInt16LE(4) > 0 && head.readUInt16LE(4) < 256) return mk('ico', ['ico'], 'ICO');
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const brands = head.toString('latin1', 8, Math.min(head.length, 64));
    if (/avif|avis/.test(brands)) return mk('avif', ['avif'], 'AVIF');
    if (/heic|heix|hevc|heim|heis|mif1|msf1/.test(brands)) return mk('heic', ['heic', 'heif'], 'HEIC');
  }
  if (looksLikeText(head)) {
    const text = head.toString('utf8', 0, Math.min(head.length, 4096)).replace(/^\uFEFF/, '');
    if (/<svg[\s>]/i.test(text)) return mk('svg', ['svg'], 'SVG');
  }
  return null;
}

/** Signatures of common NON-video binary formats, used to refuse obviously mislabelled "video" uploads. */
export function looksLikeOtherFormat(head: Buffer): boolean {
  if (sniffImage(head)) return true;
  const h4 = head.toString('latin1', 0, 4);
  return h4 === '%PDF' || h4 === 'PK\u0003\u0004' || h4 === 'Rar!' || (head[0] === 0x1f && head[1] === 0x8b) || h4 === '7z\u00bc\u00af' || h4 === 'MZ\u0090\u0000';
}
