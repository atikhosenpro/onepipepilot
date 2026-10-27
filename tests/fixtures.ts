import crypto from 'node:crypto';
import zlib from 'node:zlib';

const box = (type: string, ...payloads: Buffer[]) => {
  const body = Buffer.concat(payloads);
  const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const zeros = (n: number) => Buffer.alloc(n);

export interface Mp4Opts { seconds: number; width: number; height: number; fps?: number; rotate90?: boolean; padTo?: number; audio?: boolean }

/** Structurally valid MP4 with real moov metadata (mvhd, tkhd, mdhd, hdlr, stsd, stts) and an mdat of random bytes. */
export function craftMp4(o: Mp4Opts): Buffer {
  const fps = o.fps ?? 25, ts = 1000, dur = Math.round(o.seconds * ts);
  const mvhd = box('mvhd', zeros(4), zeros(8), u32(ts), u32(dur), u32(0x10000), zeros(2 + 10), zeros(36), zeros(24), u32(2));
  const matrix = o.rotate90 ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  const tkhd = box('tkhd', Buffer.from([0, 0, 0, 3]), zeros(8), u32(1), zeros(4), u32(dur), zeros(8), zeros(8), Buffer.concat(matrix.map(i32)), u32(o.width * 65536), u32(o.height * 65536));
  const mdhd = box('mdhd', zeros(4), zeros(8), u32(ts), u32(dur), zeros(4));
  const hdlr = box('hdlr', zeros(4), zeros(4), Buffer.from('vide'), zeros(12), zeros(1));
  const entry = (() => { const e = Buffer.concat([zeros(6), Buffer.from([0, 1]), zeros(16), Buffer.from([o.width >> 8, o.width & 255, o.height >> 8, o.height & 255]), zeros(50)]); return box('avc1', e); })();
  const stsd = box('stsd', zeros(4), u32(1), entry);
  const frames = Math.round(o.seconds * fps);
  const stts = box('stts', zeros(4), u32(1), u32(frames), u32(Math.round(ts / fps)));
  const stbl = box('stbl', stsd, stts);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)));
  const traks = [trak];
  if (o.audio) {
    const ah = box('hdlr', zeros(4), zeros(4), Buffer.from('soun'), zeros(12), zeros(1));
    const ae = box('mp4a', Buffer.concat([zeros(6), Buffer.from([0, 1]), zeros(20)]));
    traks.push(box('trak', box('mdia', mdhd, ah, box('minf', box('stbl', box('stsd', zeros(4), u32(1), ae))))));
  }
  const moov = box('moov', mvhd, ...traks);
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41'));
  const mdatPayload = crypto.randomBytes(Math.max((o.padTo ?? 4096) - ftyp.length - moov.length - 8, 16));
  return Buffer.concat([ftyp, moov, box('mdat', mdatPayload)]);
}

// ---------- images ----------
const crc32 = (buf: Buffer) => { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; };
const chunk = (type: string, data: Buffer) => { const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); return Buffer.concat([u32(data.length), td, u32(crc32(td))]); };

export function craftPng(w: number, h: number, colorType: 2 | 6 | 0 | 3 = 2): Buffer {
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, colorType, 0, 0, 0])]);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = Buffer.alloc((w * bpp + 1) * h, 0x7f);
  const extra = colorType === 3 ? [chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))] : [];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** JPEG header with an optional EXIF orientation tag and a SOF0 segment (no scan data: enough for header parsing). */
export function craftJpeg(w: number, h: number, orientation = 1, comps = 3): Buffer {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation !== 1) {
    const tiff = Buffer.concat([Buffer.from('MM'), Buffer.from([0, 42]), u32(8), Buffer.from([0, 1]), Buffer.from([0x01, 0x12, 0, 3]), u32(1), Buffer.from([0, orientation, 0, 0]), u32(0)]);
    const body = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
    parts.push(Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
  }
  const sof = Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, comps, ...Array.from({ length: comps * 3 }, () => 0)]);
  parts.push(Buffer.from([0xff, 0xc0, (sof.length + 2) >> 8, (sof.length + 2) & 255]), sof, Buffer.from([0xff, 0xd9]), crypto.randomBytes(200));
  return Buffer.concat(parts);
}

export function craftGif(w: number, h: number, transparent = false): Buffer {
  const head = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])]);
  const gce = transparent ? Buffer.from([0x21, 0xf9, 4, 1, 0, 0, 0, 0]) : Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]);
  return Buffer.concat([head, gce, Buffer.from([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2, 2, 0x44, 0x01, 0]), Buffer.from([0x3b])]);
}

export function craftBmp(w: number, h: number, bpp = 24): Buffer {
  const hdr = Buffer.alloc(54); hdr.write('BM'); hdr.writeUInt32LE(54, 10); hdr.writeUInt32LE(40, 14); hdr.writeInt32LE(w, 18); hdr.writeInt32LE(h, 22); hdr.writeUInt16LE(1, 26); hdr.writeUInt16LE(bpp, 28);
  return Buffer.concat([hdr, crypto.randomBytes(64)]);
}

export function craftWebp(w: number, h: number, alpha = false): Buffer {
  const vp8x = Buffer.alloc(10); vp8x[0] = alpha ? 0x10 : 0; vp8x.writeUIntLE(w - 1, 4, 3); vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), vp8x, Buffer.from('VP8 '), Buffer.from([8, 0, 0, 0]), crypto.randomBytes(8)]);
  const riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

export const craftSvg = (w: number, h: number, viewBoxOnly = false) =>
  Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${viewBoxOnly ? `viewBox="0 0 ${w} ${h}"` : `width="${w}" height="${h}"`}><rect width="10" height="10"/></svg>\n`);

export const craftIco = (w: number, h: number): Buffer => {
  const dir = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.from([w & 255, h & 255, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
  return Buffer.concat([dir, entry, crypto.randomBytes(40)]);
};
