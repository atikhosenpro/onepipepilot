/** Video analysers: FFprobe (when installed) and built-in header parsers (MP4/MOV/3GP, WebM/MKV, AVI). No whole-file reads. */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { round3 } from './mediaTypes';

export interface VideoMeta {
  durationSeconds: number | null; width: number | null; height: number | null; frameRate: number | null;
  videoCodec: string | null; audioCodec: string | null;
}
const empty = (): VideoMeta => ({ durationSeconds: null, width: null, height: null, frameRate: null, videoCodec: null, audioCodec: null });
export const hasAnyVideoInfo = (m: VideoMeta) => m.durationSeconds != null || (m.width != null && m.height != null);

// ---------------- FFprobe ----------------
export interface FfprobeInfo { available: boolean; path: string; version: string | null }
const ffCache = new Map<string, Promise<FfprobeInfo>>();

export function detectFfprobe(bin: string): Promise<FfprobeInfo> {
  let p = ffCache.get(bin);
  if (!p) {
    p = new Promise<FfprobeInfo>((resolve) => {
      execFile(bin, ['-version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ available: false, path: bin, version: null });
        resolve({ available: true, path: bin, version: String(stdout).split(/\r?\n/)[0]?.trim() || null });
      });
    });
    ffCache.set(bin, p);
  }
  return p;
}

const fraction = (s: unknown): number | null => {
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(String(s ?? ''));
  if (!m || Number(m[2]) === 0) return null;
  const v = Number(m[1]) / Number(m[2]);
  return v > 0 && v < 1000 ? round3(v) : null;
};

export function probeWithFfprobe(bin: string, file: string, timeoutMs: number): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error(((err as NodeJS.ErrnoException & { killed?: boolean }).killed ? 'FFprobe timed out' : String(stderr || err.message)).split('\n')[0]));
        try {
          const j = JSON.parse(String(stdout)) as { streams?: Record<string, any>[]; format?: Record<string, any> };
          const streams = j.streams ?? [];
          const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
          const a = streams.find((s) => s.codec_type === 'audio');
          const m = empty();
          if (v) {
            let w = Number(v.width) || null, h = Number(v.height) || null;
            const rot = Math.abs(Number(v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 360;
            if (w && h && (rot === 90 || rot === 270)) [w, h] = [h, w];
            m.width = w; m.height = h; m.videoCodec = v.codec_name ?? null; m.frameRate = fraction(v.avg_frame_rate) ?? fraction(v.r_frame_rate);
          }
          if (a) m.audioCodec = a.codec_name ?? null;
          const d = Number(j.format?.duration ?? v?.duration ?? a?.duration);
          m.durationSeconds = Number.isFinite(d) && d >= 0 ? round3(d) : null;
          resolve(m);
        } catch { reject(new Error('FFprobe returned unreadable output')); }
      });
  });
}

// ---------------- built-in parsers ----------------
async function readAt(fh: fs.promises.FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

interface Box { type: string; body: number; end: number }
function boxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos), hdr = 8;
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size === 1 && pos + 16 <= end) { size = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; } else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) break;
    out.push({ type, body: pos + hdr, end: pos + size });
    pos += size;
  }
  return out;
}
const child = (buf: Buffer, b: Box, type: string) => boxes(buf, b.body, b.end).find((x) => x.type === type);

const ISO_CODECS: Record<string, string> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8', mp4v: 'mpeg4', s263: 'h263', jpeg: 'mjpeg',
  mp4a: 'aac', 'ac-3': 'ac3', 'ec-3': 'eac3', opus: 'opus', alac: 'alac', samr: 'amr_nb', sawb: 'amr_wb', '.mp3': 'mp3', 'ulaw': 'pcm_mulaw', 'sowt': 'pcm_s16le', 'twos': 'pcm_s16be',
};

function parseMoov(buf: Buffer): VideoMeta {
  const m = empty();
  const moov: Box = { type: 'moov', body: 0, end: buf.length };
  const mvhd = child(buf, moov, 'mvhd');
  let movieDur: number | null = null;
  if (mvhd) {
    const v = buf[mvhd.body];
    const ts = v === 1 ? buf.readUInt32BE(mvhd.body + 20) : buf.readUInt32BE(mvhd.body + 12);
    const dur = v === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
    if (ts > 0 && dur > 0 && dur < 0xffffffff * 4) movieDur = dur / ts;
    if (movieDur == null && ts > 0) { // fragmented MP4: duration lives in mvex/mehd
      const mvex = child(buf, moov, 'mvex'); const mehd = mvex && child(buf, mvex, 'mehd');
      if (mehd) { const mv = buf[mehd.body]; const fd = mv === 1 ? Number(buf.readBigUInt64BE(mehd.body + 4)) : buf.readUInt32BE(mehd.body + 4); if (fd > 0) movieDur = fd / ts; }
    }
  }
  let trackDur: number | null = null;
  for (const trak of boxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(buf, trak, 'mdia'); if (!mdia) continue;
    const hdlr = child(buf, mdia, 'hdlr');
    const kind = hdlr ? buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) : '';
    const mdhd = child(buf, mdia, 'mdhd');
    let mdTs = 0, mdDur = 0;
    if (mdhd) { const v = buf[mdhd.body]; mdTs = v === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12); mdDur = v === 1 ? Number(buf.readBigUInt64BE(mdhd.body + 24)) : buf.readUInt32BE(mdhd.body + 16); }
    const stbl = (() => { const minf = child(buf, mdia, 'minf'); return minf && child(buf, minf, 'stbl'); })();
    const stsd = stbl && child(buf, stbl, 'stsd');
    const fourcc = stsd && stsd.body + 16 <= stsd.end ? buf.toString('latin1', stsd.body + 12, stsd.body + 16) : null;
    const codec = fourcc ? (ISO_CODECS[fourcc] ?? fourcc.trim().toLowerCase()) : null;
    if (kind === 'vide' && m.width == null) {
      m.videoCodec = codec;
      const tkhd = child(buf, trak, 'tkhd');
      if (tkhd) {
        const v = buf[tkhd.body];
        const mo = tkhd.body + (v === 1 ? 52 : 40), wo = tkhd.body + (v === 1 ? 88 : 76);
        if (wo + 8 <= tkhd.end) {
          let w = Math.round(buf.readUInt32BE(wo) / 65536), h = Math.round(buf.readUInt32BE(wo + 4) / 65536);
          const a = buf.readInt32BE(mo), b = buf.readInt32BE(mo + 4), c = buf.readInt32BE(mo + 12), d = buf.readInt32BE(mo + 16);
          if (w > 0 && h > 0 && a === 0 && d === 0 && b !== 0 && c !== 0) [w, h] = [h, w]; // rotated 90/270 degrees
          if (w > 0 && h > 0) { m.width = w; m.height = h; }
        }
      }
      if (m.width == null && stsd && fourcc && stsd.body + 48 <= stsd.end) { // fall back to the visual sample entry
        const w = buf.readUInt16BE(stsd.body + 8 + 8 + 24), h = buf.readUInt16BE(stsd.body + 8 + 8 + 26);
        if (w > 0 && h > 0) { m.width = w; m.height = h; }
      }
      const stts = stbl && child(buf, stbl, 'stts');
      if (stts && mdTs > 0 && mdDur > 0) {
        const n = buf.readUInt32BE(stts.body + 4); let samples = 0;
        for (let i = 0; i < n && stts.body + 8 + i * 8 + 4 <= stts.end; i++) samples += buf.readUInt32BE(stts.body + 8 + i * 8);
        const fps = samples / (mdDur / mdTs);
        if (samples > 1 && fps > 0 && fps < 1000) m.frameRate = round3(fps);
      }
      if (mdTs > 0 && mdDur > 0) trackDur = Math.max(trackDur ?? 0, mdDur / mdTs);
    } else if (kind === 'soun' && m.audioCodec == null) {
      m.audioCodec = codec;
      if (mdTs > 0 && mdDur > 0) trackDur = Math.max(trackDur ?? 0, mdDur / mdTs);
    }
  }
  const d = movieDur ?? trackDur;
  m.durationSeconds = d != null ? round3(d) : null;
  return m;
}

export async function parseIsoBmff(file: string): Promise<VideoMeta | null> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    let pos = 0;
    for (let i = 0; i < 100_000 && pos + 8 <= size; i++) {
      const hd = await readAt(fh, pos, 16);
      if (hd.length < 8) break;
      let boxSize = hd.readUInt32BE(0), hdr = 8;
      const type = hd.toString('latin1', 4, 8);
      if (boxSize === 1 && hd.length >= 16) { boxSize = Number(hd.readBigUInt64BE(8)); hdr = 16; } else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < hdr) break;
      if (type === 'moov') {
        if (boxSize > 64 * 1024 * 1024) return null;
        return parseMoov(await readAt(fh, pos + hdr, boxSize - hdr));
      }
      pos += boxSize;
    }
    return null;
  } finally { await fh.close(); }
}

// ---- Matroska / WebM (EBML) ----
const MKV_CODECS: Record<string, string> = {
  V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av1', 'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc', A_OPUS: 'opus', A_VORBIS: 'vorbis', A_AAC: 'aac', A_AC3: 'ac3', A_FLAC: 'flac', 'A_MPEG/L3': 'mp3',
};
function vint(buf: Buffer, pos: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) allOnes = false; }
  return { value, len, unknown: !keepMarker && allOnes };
}
const uintOf = (buf: Buffer, s: number, e: number) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + buf[i]; return v; };

export async function parseMatroska(file: string): Promise<VideoMeta | null> {
  const fh = await fs.promises.open(file, 'r');
  let buf: Buffer;
  try { buf = await readAt(fh, 0, 4 * 1024 * 1024); } finally { await fh.close(); }
  const m = empty();
  let timescale = 1_000_000, rawDuration: number | null = null, defaultNs: number | null = null;
  let stop = false;
  const walk = (start: number, end: number, parent: number): void => {
    let pos = start;
    while (pos < end && !stop) {
      const id = vint(buf, pos, true); if (!id) return;
      const sz = vint(buf, pos + id.len, false); if (!sz) return;
      const body = pos + id.len + sz.len;
      const elEnd = sz.unknown ? end : Math.min(body + sz.value, buf.length);
      switch (id.value) {
        case 0x18538067: case 0x1549a966: case 0x1654ae6b: case 0xae: case 0xe0: walk(body, elEnd, id.value); break;
        case 0x1f43b675: stop = true; return; // first Cluster: headers are behind us
        case 0x2ad7b1: if (parent === 0x1549a966) timescale = uintOf(buf, body, elEnd) || timescale; break;
        case 0x4489: if (parent === 0x1549a966) rawDuration = sz.value === 4 ? buf.readFloatBE(body) : sz.value === 8 ? buf.readDoubleBE(body) : null; break;
        case 0x83: curType = uintOf(buf, body, elEnd); break;
        case 0x86: curCodec = buf.toString('latin1', body, elEnd).replace(/\0+$/, ''); break;
        case 0x23e383: defaultNs = uintOf(buf, body, elEnd); break;
        case 0xb0: curW = uintOf(buf, body, elEnd); break;
        case 0xba: curH = uintOf(buf, body, elEnd); break;
        default: break;
      }
      if (id.value === 0xae) { // finished a TrackEntry
        if (curType === 1 && m.width == null && curW > 0 && curH > 0) { m.width = curW; m.height = curH; m.videoCodec = MKV_CODECS[curCodec] ?? curCodec.toLowerCase(); if (defaultNs) m.frameRate = round3(1e9 / defaultNs); }
        if (curType === 2 && m.audioCodec == null) m.audioCodec = MKV_CODECS[curCodec] ?? curCodec.toLowerCase();
        curType = 0; curCodec = ''; curW = 0; curH = 0; defaultNs = null;
      }
      if (elEnd <= pos) return;
      pos = elEnd;
    }
  };
  let curType = 0, curCodec = '', curW = 0, curH = 0;
  walk(0, buf.length, 0);
  if (rawDuration != null && Number.isFinite(rawDuration) && rawDuration > 0) m.durationSeconds = round3((rawDuration * timescale) / 1e9);
  return m;
}

// ---- AVI (RIFF) ----
const WAVE_TAGS: Record<number, string> = { 0x1: 'pcm', 0x55: 'mp3', 0x2000: 'ac3', 0xff: 'aac', 0x1610: 'aac', 0x161: 'wmav2', 0x160: 'wmav1' };
export async function parseAvi(file: string): Promise<VideoMeta | null> {
  const fh = await fs.promises.open(file, 'r');
  let buf: Buffer;
  try { buf = await readAt(fh, 0, 256 * 1024); } finally { await fh.close(); }
  const m = empty();
  const avih = buf.indexOf('avih', 12, 'latin1');
  if (avih < 0 || avih + 8 + 40 > buf.length) return null;
  const d = avih + 8;
  const us = buf.readUInt32LE(d), frames = buf.readUInt32LE(d + 16), w = buf.readUInt32LE(d + 32), h = buf.readUInt32LE(d + 36);
  if (us > 0 && frames > 0) { m.durationSeconds = round3((frames * us) / 1e6); m.frameRate = round3(1e6 / us); }
  if (w > 0 && h > 0) { m.width = w; m.height = h; }
  let from = avih;
  for (let i = 0; i < 8; i++) {
    const strh = buf.indexOf('strh', from, 'latin1'); if (strh < 0 || strh + 16 > buf.length) break;
    const type = buf.toString('latin1', strh + 8, strh + 12), handler = buf.toString('latin1', strh + 12, strh + 16).replace(/\0/g, '').trim().toLowerCase();
    if (type === 'vids' && !m.videoCodec) m.videoCodec = handler || null;
    if (type === 'auds' && !m.audioCodec) { const strf = buf.indexOf('strf', strh, 'latin1'); if (strf > 0 && strf + 10 <= buf.length) m.audioCodec = WAVE_TAGS[buf.readUInt16LE(strf + 8)] ?? null; }
    from = strh + 4;
  }
  return m;
}

/** Built-in analyser for the container family implied by the extension / sniffed type. Returns null when no parser exists. */
export async function probeBuiltin(file: string, ext: string): Promise<VideoMeta | null> {
  if (['mp4', 'm4v', 'mov', '3gp'].includes(ext)) return parseIsoBmff(file);
  if (['webm', 'mkv'].includes(ext)) return parseMatroska(file);
  if (ext === 'avi') return parseAvi(file);
  return null;
}
export const BUILTIN_EXTS = ['mp4', 'm4v', 'mov', '3gp', 'webm', 'mkv', 'avi'];
