import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app';
import { migrations } from '../server/migrations';
import { startBackfill } from '../server/metadata';
import { createEnv, createKey, makeConfig, makeMp4, setupAdmin, sha256, type TestEnv } from './helpers';
import { craftBmp, craftGif, craftIco, craftJpeg, craftMp4, craftPng, craftSvg, craftWebp } from './fixtures';

const NO_FFPROBE = '/nonexistent/ffprobe';
const haveFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };

let env: TestEnv; let admin: Awaited<ReturnType<typeof setupAdmin>>; let key: string;
const up = (kind: 'videos' | 'images' | 'files', buf: Buffer, filename: string, ctype?: string, e: TestEnv = env, k: string = key) => {
  const r = request(e.built.app).post(`/api/v1/${kind}`).set('Authorization', `Bearer ${k}`);
  return ctype ? r.attach('data', buf, { filename, contentType: ctype }) : r.attach('data', buf, { filename });
};
const list = (kind: string, qs = '', e: TestEnv = env, k: string = key) => request(e.built.app).get(`/api/v1/${kind}${qs ? '?' + qs : ''}`).set('Authorization', `Bearer ${k}`);
const pathOf = (url: string) => new URL(url).pathname;

beforeAll(async () => {
  env = createEnv({ ffprobePath: NO_FFPROBE }); // built-in analysers only
  admin = await setupAdmin(env);
  key = (await createKey(admin)).key;
});
afterAll(() => env.cleanup());

describe('database migration safety', () => {
  it('keeps every pre-existing record, ID, file and URL, then backfills metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvh-mig-'));
    const cfg = makeConfig(root, { ffprobePath: NO_FFPROBE });
    for (const d of [cfg.dataDir!, ...Object.values(cfg.dirs!)]) fs.mkdirSync(d, { recursive: true });
    // Build a database exactly as the previous release left it (schema v1 only).
    const old = new Database(cfg.dbPath!);
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    old.exec(migrations[0].sql);
    old.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(migrations[0].name, new Date().toISOString());
    const bytes = craftMp4({ seconds: 12, width: 1280, height: 720 });
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(cfg.dirs!.uploads, `${id}.mp4`), bytes);
    const now = new Date().toISOString();
    old.prepare("INSERT INTO videos (id, original_name, storage_name, mime_type, extension, size, sha256, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?)")
      .run(id, 'legacy.mp4', `${id}.mp4`, 'video/mp4', 'mp4', bytes.length, sha256(bytes), now, now);
    old.prepare('INSERT INTO api_keys (id, label, key_prefix, key_hash, created_at) VALUES (?,?,?,?,?)').run('legacykey01', 'legacy', 'lvh_legacykey01', crypto.createHash('sha256').update('lvh_legacykey01_secret').digest('hex'), now);
    old.prepare("INSERT INTO settings VALUES ('trashRetentionDays', '14', ?)").run(now);
    old.close();

    const built = buildApp({ config: cfg, silent: true });
    try {
      const row = built.ctx.db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as Record<string, unknown>;
      expect(row).toMatchObject({ id, original_name: 'legacy.mp4', storage_name: `${id}.mp4`, size: bytes.length, status: 'active', media_type: 'video', metadata_status: 'pending', duration_seconds: null });
      expect((built.ctx.db.prepare('SELECT COUNT(*) c FROM api_keys').get() as { c: number }).c).toBe(1);
      expect(built.ctx.settings().trashRetentionDays).toBe(14);
      expect((built.ctx.db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v).toBe(migrations[migrations.length - 1].version); // old v1 database is upgraded through every later migration
      // the old public URL still works
      const pub = await request(built.app).get(`/videos/${id}.mp4`).buffer(true).parse(binary);
      expect(pub.status).toBe(200); expect(pub.body.equals(bytes)).toBe(true);
      // the old API key still authenticates
      const listed = await request(built.app).get('/api/v1/videos').set('Authorization', 'Bearer lvh_legacykey01_secret');
      expect(listed.status).toBe(200);
      expect(listed.body.items[0]).toMatchObject({ id, originalName: 'legacy.mp4', metadataStatus: 'pending', durationSeconds: null, width: null });
      // controlled backfill
      const job = startBackfill(built.ctx, { statuses: ['pending'] });
      expect(job).toMatchObject({ started: true, queued: 1 });
      await built.ctx.metadata.promise;
      const after = await request(built.app).get(`/api/v1/videos/${id}`).set('Authorization', 'Bearer lvh_legacykey01_secret');
      expect(after.body.item).toMatchObject({ id, metadataStatus: 'ready', metadataSource: 'builtin', durationSeconds: 12, width: 1280, height: 720, aspectRatio: '16:9', orientation: 'landscape', resolution: '1280x720', resolutionCategory: '720p' });
      expect(fs.readFileSync(path.join(cfg.dirs!.uploads, `${id}.mp4`)).equals(bytes)).toBe(true); // file untouched
    } finally { built.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('video metadata (built-in analyser)', () => {
  it('extracts duration, dimensions, ratio, codecs and classification into individual JSON fields', async () => {
    const buf = craftMp4({ seconds: 95, width: 1920, height: 1080, fps: 25, audio: true });
    const res = await up('videos', buf, 'Landscape Clip.mp4', 'video/mp4');
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      mediaType: 'video', fileName: 'Landscape Clip.mp4', originalName: 'Landscape Clip.mp4', extension: 'mp4', mimeType: 'video/mp4', sizeBytes: buf.length, size: buf.length,
      durationSeconds: 95, durationFormatted: '00:01:35', durationMinutes: 1.5833, width: 1920, height: 1080, resolution: '1920x1080', resolutionCategory: '1080p',
      aspectRatio: '16:9', aspectRatioValue: 1.7778, orientation: 'landscape', frameRate: 25, videoCodec: 'h264', audioCodec: 'aac', videoClass: 'long', isShort: false,
      status: 'active', metadataStatus: 'ready', metadataSource: 'builtin', metadataError: null,
    });
    expect(Number.isInteger(res.body.item.sizeBytes)).toBe(true);
    expect(res.body.item.sizeMB).toBe(Math.round((buf.length / 1048576) * 100) / 100);
    expect(res.body.item.uploadedAt).toBe(res.body.item.createdAt);
    expect(res.body.item.publicUrl).toBe(`http://localhost:3000/videos/${res.body.item.id}.mp4`);
  });
  it('applies the rotation flag so phone videos report their displayed size', async () => {
    const res = await up('videos', craftMp4({ seconds: 20, width: 1920, height: 1080, rotate90: true }), 'phone.mp4');
    expect(res.body.item).toMatchObject({ width: 1080, height: 1920, resolution: '1080x1920', aspectRatio: '9:16', aspectRatioValue: 0.5625, orientation: 'portrait', videoClass: 'short', isShort: true });
  });
  it('reports square and 4:5 ratios', async () => {
    const sq = await up('videos', craftMp4({ seconds: 5, width: 1080, height: 1080 }), 'sq.mp4');
    expect(sq.body.item).toMatchObject({ aspectRatio: '1:1', orientation: 'square' });
    const p45 = await up('videos', craftMp4({ seconds: 5, width: 1080, height: 1350 }), 'p45.mp4');
    expect(p45.body.item).toMatchObject({ aspectRatio: '4:5', orientation: 'portrait' });
  });
  it('stores a video it cannot analyse and says so, instead of inventing values', async () => {
    const res = await up('videos', crypto.randomBytes(6000), 'camera.mpg', 'video/mpeg');
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ extension: 'mpg', mimeType: 'video/mpeg', metadataStatus: 'unavailable', durationSeconds: null, durationFormatted: null, width: null, height: null, aspectRatio: null, orientation: null, videoClass: null, isShort: null });
    expect(res.body.item.metadataError).toMatch(/FFprobe/);
    const pub = await request(env.built.app).get(pathOf(res.body.item.publicUrl));
    expect(pub.status).toBe(200);
  });
  it('still refuses text, other formats and unknown extensions posing as video', async () => {
    expect((await up('videos', Buffer.from('hello world, not a video\n'.repeat(50)), 'x.mkv')).status).toBe(415);
    expect((await up('videos', craftPng(10, 10), 'x.mp4')).status).toBe(415);
    expect((await up('videos', crypto.randomBytes(5000), 'x.abc')).status).toBe(415);
    expect((await up('videos', crypto.randomBytes(5000), 'noext')).status).toBe(415);
    expect((await up('videos', makeMp4(5000), 'x.mp4', 'image/png')).status).toBe(415);
  });
  it('honours the configurable short-video threshold retroactively', async () => {
    const mk = await up('videos', craftMp4({ seconds: 45, width: 640, height: 360 }), 'threshold.mp4');
    const id = mk.body.item.id;
    expect(mk.body.item.isShort).toBe(true);
    const put = await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ shortVideoMaxSeconds: 30 });
    expect(put.status).toBe(200);
    expect((await request(env.built.app).get(`/api/v1/videos/${id}`).set('Authorization', `Bearer ${key}`)).body.item).toMatchObject({ videoClass: 'long', isShort: false });
    const shortList = await list('videos', 'videoClass=short&search=threshold');
    expect(shortList.body.total).toBe(0);
    await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ shortVideoMaxSeconds: 60 });
    expect((await list('videos', 'videoClass=short&search=threshold')).body.total).toBe(1);
    expect((await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ shortVideoMaxSeconds: 0 })).status).toBe(400);
  });
});

describe.skipIf(!haveFfmpeg)('all video formats with FFprobe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvh-fx-'));
  let ffEnv: TestEnv; let ffKey: string;
  const files: Record<string, { seconds: number; width: number; height: number }> = {
    'a.mp4': { seconds: 2, width: 320, height: 180 }, 'a.mov': { seconds: 2, width: 320, height: 180 }, 'a.m4v': { seconds: 2, width: 320, height: 180 }, 'a.webm': { seconds: 2, width: 320, height: 180 },
    'a.mkv': { seconds: 2, width: 320, height: 180 }, 'a.avi': { seconds: 2, width: 320, height: 180 }, 'a.mpg': { seconds: 2, width: 320, height: 180 }, 'a.mpeg': { seconds: 2, width: 320, height: 180 },
    'a.wmv': { seconds: 2, width: 320, height: 180 }, 'a.flv': { seconds: 2, width: 320, height: 180 }, 'a.3gp': { seconds: 2, width: 176, height: 144 }, 'a.ts': { seconds: 2, width: 320, height: 180 }, 'a.mts': { seconds: 2, width: 320, height: 180 },
  };
  beforeAll(async () => {
    const lav = ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '2'];
    const run = (...a: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'ignore' });
    run(...lav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4'));
    fs.copyFileSync(path.join(dir, 'a.mp4'), path.join(dir, 'a.mov')); fs.copyFileSync(path.join(dir, 'a.mp4'), path.join(dir, 'a.m4v'));
    run(...lav, '-c:v', 'libvpx', path.join(dir, 'a.webm'));
    run(...lav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mkv'));
    run(...lav, '-c:v', 'mpeg4', path.join(dir, 'a.avi'));
    run(...lav, '-c:v', 'mpeg1video', path.join(dir, 'a.mpg')); fs.copyFileSync(path.join(dir, 'a.mpg'), path.join(dir, 'a.mpeg'));
    run(...lav, '-c:v', 'wmv2', path.join(dir, 'a.wmv'));
    run(...lav, '-c:v', 'flv', path.join(dir, 'a.flv'));
    run('-f', 'lavfi', '-i', 'testsrc=size=176x144:rate=10', '-t', '2', '-c:v', 'h263', path.join(dir, 'a.3gp'));
    run(...lav, '-c:v', 'mpeg2video', path.join(dir, 'a.ts'));
    const ts = fs.readFileSync(path.join(dir, 'a.ts')); const m2 = Buffer.alloc((ts.length / 188) * 192);
    for (let i = 0; i < ts.length / 188; i++) ts.copy(m2, i * 192 + 4, i * 188, i * 188 + 188);
    fs.writeFileSync(path.join(dir, 'a.mts'), m2);
    ffEnv = createEnv(); // default: uses ffprobe
    const a = await setupAdmin(ffEnv); ffKey = (await createKey(a)).key;
  });
  afterAll(() => { ffEnv?.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });

  for (const name of Object.keys(files)) {
    it(`stores and analyses .${name.split('.')[1]}`, async () => {
      const buf = fs.readFileSync(path.join(dir, name));
      const res = await up('videos', buf, `sample.${name.split('.')[1]}`, undefined, ffEnv, ffKey);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const exp = files[name];
      const storedExt = ['mov', 'm4v'].includes(name.split('.')[1]) ? 'mp4' : name.split('.')[1]; // MP4-family files keep the container-based extension (unchanged behaviour)
      expect(res.body.item).toMatchObject({ extension: storedExt, metadataStatus: 'ready', metadataSource: 'ffprobe', width: exp.width, height: exp.height, sizeBytes: buf.length, isShort: true });
      expect(Math.abs(res.body.item.durationSeconds - exp.seconds)).toBeLessThan(0.3);
      const pub = await request(ffEnv.built.app).get(pathOf(res.body.item.publicUrl)).buffer(true).parse(binary);
      expect(pub.status).toBe(200); expect(pub.body.equals(buf)).toBe(true);
      expect(pub.headers['content-type']).toMatch(/^video\//);
    });
  }
});

describe('image library', () => {
  const cases: [string, Buffer, Record<string, unknown>][] = [
    ['photo.jpg', craftJpeg(400, 300), { imageFormat: 'JPEG', width: 400, height: 300, aspectRatio: '4:3', orientation: 'landscape', hasAlpha: false, colorSpace: 'rgb', mimeType: 'image/jpeg' }],
    ['exif-rotated.jpeg', craftJpeg(4000, 3000, 6), { width: 3000, height: 4000, aspectRatio: '3:4', orientation: 'portrait' }],
    ['gray.jpg', craftJpeg(10, 10, 1, 1), { colorSpace: 'grayscale', orientation: 'square', aspectRatio: '1:1' }],
    ['cmyk.jpg', craftJpeg(10, 20, 1, 4), { colorSpace: 'cmyk' }],
    ['icon.png', craftPng(200, 100), { imageFormat: 'PNG', width: 200, height: 100, aspectRatio: '2:1', hasAlpha: false, colorSpace: 'rgb', mimeType: 'image/png' }],
    ['alpha.png', craftPng(64, 32, 6), { hasAlpha: true, aspectRatio: '2:1' }],
    ['indexed.png', craftPng(20, 20, 3), { colorSpace: 'indexed' }],
    ['anim.gif', craftGif(90, 60, true), { imageFormat: 'GIF', width: 90, height: 60, hasAlpha: true, mimeType: 'image/gif', aspectRatio: '3:2' }],
    ['opaque.gif', craftGif(10, 10, false), { hasAlpha: false }],
    ['pic.bmp', craftBmp(50, 40), { imageFormat: 'BMP', width: 50, height: 40, mimeType: 'image/bmp', hasAlpha: false }],
    ['pic.webp', craftWebp(120, 80, true), { imageFormat: 'WebP', width: 120, height: 80, hasAlpha: true, mimeType: 'image/webp' }],
    ['fav.ico', craftIco(32, 32), { imageFormat: 'ICO', width: 32, height: 32, mimeType: 'image/x-icon' }],
    ['logo.svg', craftSvg(300, 150), { imageFormat: 'SVG', width: 300, height: 150, mimeType: 'image/svg+xml', aspectRatio: '2:1' }],
    ['viewbox.svg', craftSvg(100, 100, true), { width: 100, height: 100, orientation: 'square' }],
  ];
  for (const [name, buf, expected] of cases) {
    it(`analyses ${name}`, async () => {
      const res = await up('images', buf, name);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.item).toMatchObject({ mediaType: 'image', metadataStatus: 'ready', status: 'active', fileName: name, sizeBytes: buf.length, ...expected });
      expect(res.body.item.resolution).toBe(`${res.body.item.width}x${res.body.item.height}`);
      expect(res.body.item.aspectRatioValue).toBeCloseTo(res.body.item.width / res.body.item.height, 3);
      expect(res.body.publicUrl).toBe(`http://localhost:3000/images/${res.body.item.id}.${res.body.item.extension}`);
      const pub = await request(env.built.app).get(pathOf(res.body.publicUrl)).buffer(true).parse(binary);
      expect(pub.status).toBe(200); expect(pub.body.equals(buf)).toBe(true);
      expect(pub.headers['content-type']).toBe(res.body.item.mimeType);
    });
  }
  it('serves SVG without letting scripts run, and keeps image IDs out of /videos and /files', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const res = await up('images', svg, 'evil.svg');
    const pub = await request(env.built.app).get(pathOf(res.body.publicUrl));
    expect(pub.headers['content-type']).toBe('image/svg+xml');
    expect(pub.headers['content-security-policy']).toMatch(/sandbox/);
    expect(pub.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(pub.headers['x-content-type-options']).toBe('nosniff');
    const id = res.body.item.id;
    expect((await request(env.built.app).get(`/videos/${id}.svg`)).status).toBe(404);
    expect((await request(env.built.app).get(`/files/${id}.svg`)).status).toBe(404);
    expect((await list('images', `search=${id.slice(0, 8)}`)).body.total).toBe(1);
    expect((await request(env.built.app).get(`/api/v1/videos/${id}`).set('Authorization', `Bearer ${key}`)).status).toBe(404);
  });
  it('rejects non-images and mismatched extensions, but stores unanalysable image formats', async () => {
    expect((await up('images', Buffer.from('just some text\n'.repeat(30)), 'a.png')).status).toBe(415);
    expect((await up('images', craftPng(5, 5), 'a.jpg')).status).toBe(415);
    expect((await up('images', crypto.randomBytes(3000), 'a.png')).status).toBe(415);
    expect((await up('images', craftJpeg(5, 5), 'x.jpg', 'video/mp4')).status).toBe(415);
    const heic = await up('images', crypto.randomBytes(4000), 'photo.heic');
    expect(heic.status).toBe(201);
    expect(heic.body.item).toMatchObject({ extension: 'heic', mimeType: 'image/heic', metadataStatus: 'unavailable', width: null, height: null, aspectRatio: null, orientation: null, hasAlpha: null });
  });
});

describe('file library', () => {
  const rnd = (n = 3000) => crypto.randomBytes(n);
  const cases: [string, Buffer, { category: string; mimeType: string; disposition: RegExp; type: RegExp }][] = [
    ['report.pdf', Buffer.from('%PDF-1.4\n' + 'x'.repeat(200)), { category: 'document', mimeType: 'application/pdf', disposition: /^inline/, type: /^application\/pdf/ }],
    ['sheet.xlsx', rnd(), { category: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: /^attachment/, type: /spreadsheetml/ }],
    ['notes.txt', Buffer.from('plain text'), { category: 'document', mimeType: 'text/plain', disposition: /^inline/, type: /^text\/plain/ }],
    ['table.csv', Buffer.from('a,b\n1,2\n'), { category: 'data', mimeType: 'text/csv', disposition: /^inline/, type: /^text\/plain/ }],
    ['data.json', Buffer.from('{"a":1}'), { category: 'data', mimeType: 'application/json', disposition: /^inline/, type: /^application\/json/ }],
    ['feed.xml', Buffer.from('<?xml version="1.0"?><a/>'), { category: 'data', mimeType: 'application/xml', disposition: /^attachment/, type: /octet-stream/ }],
    ['page.html', Buffer.from('<html><script>alert(1)</script></html>'), { category: 'code', mimeType: 'text/html', disposition: /^attachment/, type: /octet-stream/ }],
    ['app.js', Buffer.from('alert(1)'), { category: 'code', mimeType: 'text/javascript', disposition: /^attachment/, type: /octet-stream/ }],
    ['style.css', Buffer.from('body{}'), { category: 'code', mimeType: 'text/css', disposition: /^attachment/, type: /octet-stream/ }],
    ['shell.php', Buffer.from('<?php echo 1;'), { category: 'code', mimeType: 'application/x-httpd-php', disposition: /^attachment/, type: /octet-stream/ }],
    ['bundle.zip', rnd(), { category: 'archive', mimeType: 'application/zip', disposition: /^attachment/, type: /zip/ }],
    ['pack.rar', rnd(), { category: 'archive', mimeType: 'application/vnd.rar', disposition: /^attachment/, type: /rar/ }],
    ['pack.7z', rnd(), { category: 'archive', mimeType: 'application/x-7z-compressed', disposition: /^attachment/, type: /7z/ }],
    ['song.mp3', rnd(), { category: 'audio', mimeType: 'audio/mpeg', disposition: /^inline/, type: /^audio\/mpeg/ }],
    ['sound.wav', rnd(), { category: 'audio', mimeType: 'audio/wav', disposition: /^inline/, type: /^audio\/wav/ }],
    ['mystery.xyz', rnd(), { category: 'other', mimeType: 'application/octet-stream', disposition: /^attachment/, type: /octet-stream/ }],
    ['noextension', rnd(), { category: 'other', mimeType: 'application/octet-stream', disposition: /^attachment/, type: /octet-stream/ }],
  ];
  for (const [name, buf, exp] of cases) {
    it(`stores ${name} and delivers it safely`, async () => {
      const res = await up('files', buf, name, 'application/x-whatever');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.item).toMatchObject({ mediaType: 'file', category: exp.category, mimeType: exp.mimeType, sizeBytes: buf.length, status: 'active', metadataStatus: 'ready', sha256: sha256(buf) });
      expect(res.body.item.width).toBeUndefined();
      expect(res.body.publicUrl).toBe(`http://localhost:3000/files/${res.body.item.id}.${res.body.item.extension}`);
      const pub = await request(env.built.app).get(pathOf(res.body.publicUrl)).buffer(true).parse(binary);
      expect(pub.status).toBe(200); expect(pub.body.equals(buf)).toBe(true);
      expect(pub.headers['content-disposition']).toMatch(exp.disposition);
      expect(pub.headers['content-type']).toMatch(exp.type);
      expect(pub.headers['x-content-type-options']).toBe('nosniff');
      if (exp.category === 'code' || /\.(xml)$/.test(name)) expect(pub.headers['content-security-policy']).toMatch(/sandbox/);
      const dl = await request(env.built.app).get(`${pathOf(res.body.publicUrl)}?download=1`);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    });
  }
  it('never uses the client-declared MIME type or extension tricks as a storage key', async () => {
    const res = await up('files', Buffer.from('x'), '../../etc/passwd.html', 'text/html');
    expect(res.status).toBe(201);
    expect(res.body.item.originalName).toBe('passwd.html');
    expect(res.body.item.id).toMatch(/^[0-9a-f-]{36}$/);
    const weird = await up('files', Buffer.from('x'), 'a.b$c', 'text/html');
    expect(weird.body.item.extension).toBe('bin');
  });
  it('supports ranges on files and rejects empty uploads', async () => {
    const big = crypto.randomBytes(200_000);
    const res = await up('files', big, 'big.zip');
    const r = await request(env.built.app).get(pathOf(res.body.publicUrl)).set('Range', 'bytes=1000-1999').buffer(true).parse(binary);
    expect(r.status).toBe(206); expect(r.body.equals(big.subarray(1000, 2000))).toBe(true);
    expect((await up('files', Buffer.alloc(0), 'empty.txt')).status).toBe(400);
  });
});

describe('API filtering, sorting and pagination', () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    const mk = async (name: string, o: Parameters<typeof craftMp4>[0]) => { const r = await up('videos', craftMp4(o), name); expect(r.status).toBe(201); ids[name] = r.body.item.id; };
    await mk('flt-portrait-120s.mp4', { seconds: 120, width: 1080, height: 1920, padTo: 2_200_000 });
    await mk('flt-portrait-30s.mp4', { seconds: 30, width: 1080, height: 1920, padTo: 300_000 });
    await mk('flt-landscape-200s.mp4', { seconds: 200, width: 1920, height: 1080, padTo: 3_000_000 });
    await mk('flt-landscape-90s.mp4', { seconds: 90, width: 1280, height: 720, padTo: 1_500_000 });
    await mk('flt-square-10s.mp4', { seconds: 10, width: 720, height: 720, padTo: 100_000 });
    const unk = await up('videos', crypto.randomBytes(2000), 'flt-unknown.mpg'); ids['flt-unknown.mpg'] = unk.body.item.id;
    const wm = await up('videos', makeMp4(80_000), 'flt-plain.mp4'); ids['flt-plain.mp4'] = wm.body.item.id;
  });
  const names = async (qs: string) => (await list('videos', `search=flt-&${qs}`)).body.items.map((i: { fileName: string }) => i.fileName).sort();

  it('applies the documented example: several filters at once', async () => {
    const res = await list('videos', 'search=flt-&minDuration=60&maxDuration=180&minSizeMB=1&maxSizeMB=3&aspectRatio=9%3A16&status=active');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { fileName: string }) => i.fileName)).toEqual(['flt-portrait-120s.mp4']);
    expect(res.body.total).toBe(1);
  });
  it('filters by each parameter', async () => {
    expect(await names('orientation=portrait')).toEqual(['flt-portrait-120s.mp4', 'flt-portrait-30s.mp4']);
    expect(await names('orientation=square')).toEqual(['flt-square-10s.mp4']);
    expect(await names('aspectRatio=16:9')).toEqual(['flt-landscape-200s.mp4', 'flt-landscape-90s.mp4']);
    expect(await names('aspectRatio=0.5625')).toEqual(['flt-portrait-120s.mp4', 'flt-portrait-30s.mp4']);
    expect(await names('minDuration=100')).toEqual(['flt-landscape-200s.mp4', 'flt-portrait-120s.mp4']);
    expect(await names('maxDuration=30')).toEqual(['flt-portrait-30s.mp4', 'flt-square-10s.mp4']);
    expect(await names('minWidth=1920')).toEqual(['flt-landscape-200s.mp4']);
    expect(await names('maxWidth=720')).toEqual(['flt-square-10s.mp4']);
    expect(await names('minHeight=1900')).toEqual(['flt-portrait-120s.mp4', 'flt-portrait-30s.mp4']);
    expect(await names('maxHeight=720')).toEqual(['flt-landscape-90s.mp4', 'flt-square-10s.mp4']);
    expect(await names('videoClass=short')).toEqual(['flt-portrait-30s.mp4', 'flt-square-10s.mp4']);
    expect(await names('videoClass=long')).toEqual(['flt-landscape-200s.mp4', 'flt-landscape-90s.mp4', 'flt-portrait-120s.mp4']);
    expect(await names('extension=mpg')).toEqual(['flt-unknown.mpg']);
    expect(await names('type=mpg')).toEqual(['flt-unknown.mpg']);
    expect(await names('mimeType=video/mpeg')).toEqual(['flt-unknown.mpg']);
    expect(await names('type=video/mpeg')).toEqual(['flt-unknown.mpg']);
    expect(await names('mimeType=video/*&extension=mp4,mpg')).toHaveLength(7);
    expect(await names('resolution=1920x1080')).toEqual(['flt-landscape-200s.mp4']);
    expect(await names('resolutionCategory=720p')).toEqual(['flt-landscape-90s.mp4', 'flt-square-10s.mp4']);
    expect(await names('metadataStatus=unavailable')).toEqual(['flt-unknown.mpg']);
    expect(await names('minSizeMB=2.5')).toEqual(['flt-landscape-200s.mp4']);
    expect((await list('videos', 'search=flt-portrait')).body.items.map((i: { fileName: string }) => i.fileName).sort()).toEqual(['flt-portrait-120s.mp4', 'flt-portrait-30s.mp4']);
    expect((await list('videos', 'search=a&search=b')).status).toBe(400); // repeated parameter is rejected, not mis-read
  });
  it('combines filters with AND and returns nothing when they conflict', async () => {
    expect(await names('orientation=portrait&videoClass=long')).toEqual(['flt-portrait-120s.mp4']);
    expect(await names('orientation=portrait&maxDuration=20')).toEqual([]);
    expect(await names('orientation=landscape&minDuration=100&maxSizeMB=1')).toEqual([]);
  });
  it('filters by upload date and status', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect((await names(`uploadedFrom=${today}`)).length).toBeGreaterThanOrEqual(7);
    expect(await names('uploadedTo=2000-01-01')).toEqual([]);
    expect(await names('uploadedFrom=2999-01-01')).toEqual([]);
    expect(await names(`uploadedFrom=${new Date(Date.now() - 3600_000).toISOString()}&uploadedTo=${new Date(Date.now() + 3600_000).toISOString()}`)).toHaveLength(7);
    expect(await names('status=trashed')).toEqual([]);
    const t = await admin.agent.post('/api/admin/videos/trash').set('X-CSRF-Token', admin.csrf).send({ ids: [ids['flt-square-10s.mp4']] });
    expect(t.body.succeeded).toBe(1);
    expect(await names('status=trashed')).toEqual(['flt-square-10s.mp4']);
    expect(await names('')).not.toContain('flt-square-10s.mp4');
    expect((await names('status=all')).length).toBe(7);
    const item = (await list('videos', 'status=trashed&search=flt-square')).body.items[0];
    expect(item.publicUrl).toBeNull(); expect(item.status).toBe('trashed');
    await admin.agent.post('/api/admin/videos/restore').set('X-CSRF-Token', admin.csrf).send({ ids: [ids['flt-square-10s.mp4']] });
  });
  it('sorts, with unknown values last, and accepts alias names', async () => {
    const s = async (qs: string) => (await list('videos', `search=flt-&${qs}`)).body.items.map((i: { fileName: string }) => i.fileName);
    expect((await s('sortBy=duration&order=asc')).slice(0, 5)).toEqual(['flt-square-10s.mp4', 'flt-portrait-30s.mp4', 'flt-landscape-90s.mp4', 'flt-portrait-120s.mp4', 'flt-landscape-200s.mp4']);
    const desc = await s('sortBy=durationSeconds&order=desc');
    expect(desc.slice(0, 2)).toEqual(['flt-landscape-200s.mp4', 'flt-portrait-120s.mp4']);
    expect(desc.slice(-2).sort()).toEqual(['flt-plain.mp4', 'flt-unknown.mpg'].sort()); // null durations are last in both directions
    expect((await s('sortBy=duration&order=asc')).slice(-2).sort()).toEqual(['flt-plain.mp4', 'flt-unknown.mpg'].sort());
    expect((await s('sortBy=fileName&order=asc'))[0]).toBe('flt-landscape-200s.mp4');
    expect((await s('sortBy=size&order=desc'))[0]).toBe('flt-landscape-200s.mp4');
    expect((await s('sort=size&order=asc'))[0]).not.toBe('flt-landscape-200s.mp4');
    const byDate = await s('sortBy=uploadedAt&order=asc'); expect(byDate[0]).toBe('flt-portrait-120s.mp4');
  });
  it('paginates consistently', async () => {
    const seen: string[] = [];
    let page = 1, totalPages: number;
    for (;;) {
      const r = await list('videos', `search=flt-&limit=3&page=${page}&sortBy=fileName&order=asc`);
      expect(r.body).toMatchObject({ page, pageSize: 3, limit: 3, total: 7 });
      totalPages = r.body.totalPages;
      seen.push(...r.body.items.map((i: { id: string }) => i.id));
      expect(r.body.hasMore).toBe(page < totalPages);
      if (!r.body.hasMore) break;
      page++;
    }
    expect(totalPages).toBe(3); expect(seen).toHaveLength(7); expect(new Set(seen).size).toBe(7);
    expect((await list('videos', 'search=flt-&limit=3&page=99')).body.items).toEqual([]);
    expect((await list('videos', 'search=flt-&pageSize=2')).body.items).toHaveLength(2); // legacy name still works
  });
  it('validates parameters with clear 400 errors instead of crashing', async () => {
    for (const qs of ['minDuration=abc', 'minSizeMB=-5', 'limit=0', 'limit=1000', 'page=0', 'orientation=diagonal', 'videoClass=medium', 'aspectRatio=widescreen', 'resolution=big', 'resolutionCategory=8K', 'uploadedFrom=yesterday', 'status=deleted', 'sortBy=password', 'order=sideways', 'maxWidth=x']) {
      const r = await list('videos', qs);
      expect(r.status, qs).toBe(400);
      expect(r.body).toMatchObject({ success: false, error: { code: 'validation_error' } });
    }
    expect((await list('videos', 'minDuration=&maxDuration=')).status).toBe(200); // blank values are ignored
    expect((await list('videos', "search=%27%3B%20DROP%20TABLE%20videos%3B--")).body.total).toBe(0); // injection attempt is just text
    expect((await list('videos')).status).toBe(200);
  });
  it('keeps libraries separate and filters images and files', async () => {
    const [i1, i2, i3] = await Promise.all([up('images', craftPng(1920, 1080), 'flt-img-wide.png'), up('images', craftJpeg(800, 1200), 'flt-img-tall.jpg'), up('images', craftWebp(500, 500, true), 'flt-img-sq.webp')]);
    expect([i1.status, i2.status, i3.status]).toEqual([201, 201, 201]);
    const n = async (qs: string, kind = 'images') => (await list(kind, `search=flt-&${qs}`)).body.items.map((i: { fileName: string }) => i.fileName).sort();
    expect(await n('')).toEqual(['flt-img-sq.webp', 'flt-img-tall.jpg', 'flt-img-wide.png']);
    expect(await n('extension=png')).toEqual(['flt-img-wide.png']);
    expect(await n('imageFormat=webp')).toEqual(['flt-img-sq.webp']);
    expect(await n('mimeType=image/jpeg')).toEqual(['flt-img-tall.jpg']);
    expect(await n('orientation=portrait')).toEqual(['flt-img-tall.jpg']);
    expect(await n('aspectRatio=1:1')).toEqual(['flt-img-sq.webp']);
    expect(await n('minWidth=800&maxWidth=1000')).toEqual(['flt-img-tall.jpg']);
    expect(await n('minHeight=1000&orientation=landscape')).toEqual(['flt-img-wide.png']);
    expect(await n('sortBy=width&order=desc')).toEqual(['flt-img-sq.webp', 'flt-img-tall.jpg', 'flt-img-wide.png']);
    expect((await list('images', 'sortBy=width&order=desc&search=flt-')).body.items[0].fileName).toBe('flt-img-wide.png');
    expect((await names('')).some((x: string) => x.startsWith('flt-img'))).toBe(false); // images never appear in the video list
    await up('files', Buffer.from('a,b'), 'flt-doc.csv'); await up('files', crypto.randomBytes(2000), 'flt-pack.zip'); await up('files', crypto.randomBytes(500_000), 'flt-song.mp3');
    expect(await n('', 'files')).toEqual(['flt-doc.csv', 'flt-pack.zip', 'flt-song.mp3']);
    expect(await n('category=archive', 'files')).toEqual(['flt-pack.zip']);
    expect(await n('category=audio&minSizeMB=0.1', 'files')).toEqual(['flt-song.mp3']);
    expect(await n('extension=csv', 'files')).toEqual(['flt-doc.csv']);
    expect(await n('mimeType=audio/mpeg', 'files')).toEqual(['flt-song.mp3']);
    expect(await n('category=other', 'files')).toEqual([]);
    expect((await list('files', 'category=spaceship')).status).toBe(400);
  });
  it('keeps the original response fields and shapes (backward compatible)', async () => {
    const r = await list('videos', 'limit=1');
    expect(Object.keys(r.body).sort()).toEqual(expect.arrayContaining(['success', 'items', 'page', 'pageSize', 'total', 'totalPages']));
    for (const f of ['id', 'originalName', 'mimeType', 'extension', 'size', 'sha256', 'status', 'createdAt', 'updatedAt', 'trashedAt', 'publicUrl', 'downloadUrl']) expect(r.body.items[0], f).toHaveProperty(f);
    const one = await request(env.built.app).get(`/api/v1/videos/${ids['flt-plain.mp4']}`).set('Authorization', `Bearer ${key}`);
    expect(one.body).toMatchObject({ success: true, item: { id: ids['flt-plain.mp4'] } });
  });
});

describe('dashboard API, trash across libraries and reprocessing', () => {
  it('lists any library for the dashboard and trashes/restores/deletes images and files', async () => {
    const img = await up('images', craftPng(30, 30), 'trash-me.png');
    const file = await up('files', Buffer.from('x'), 'trash-me.txt');
    const iid = img.body.item.id, fid = file.body.item.id;
    const imgs = await admin.agent.get('/api/admin/videos?mediaType=image&q=trash-me');
    expect(imgs.body.items.map((i: { id: string }) => i.id)).toEqual([iid]);
    const act = (p: string, ids: string[]) => admin.agent.post(`/api/admin/videos/${p}`).set('X-CSRF-Token', admin.csrf).send({ ids });
    expect((await act('trash', [iid, fid])).body.succeeded).toBe(2);
    expect((await request(env.built.app).get(pathOf(img.body.publicUrl))).status).toBe(410);
    expect((await request(env.built.app).get(pathOf(file.body.publicUrl))).status).toBe(410);
    const trashed = await admin.agent.get('/api/admin/videos?mediaType=all&status=trashed&q=trash-me');
    expect(trashed.body.items.map((i: { mediaType: string }) => i.mediaType).sort()).toEqual(['file', 'image']);
    expect((await act('restore', [iid])).body.succeeded).toBe(1);
    expect((await request(env.built.app).get(pathOf(img.body.publicUrl))).status).toBe(200);
    expect((await act('delete', [fid])).body.succeeded).toBe(1);
    expect(fs.readdirSync(env.built.ctx.config.dirs.trash).some((f) => f.startsWith(fid))).toBe(false);
    expect((await request(env.built.app).get(pathOf(file.body.publicUrl))).status).toBe(404);
  });
  it('requires authentication for every new endpoint', async () => {
    for (const p of ['videos', 'images', 'files']) {
      expect((await request(env.built.app).get(`/api/v1/${p}`)).status).toBe(401);
      expect((await request(env.built.app).post(`/api/v1/${p}`).attach('data', Buffer.from('x'), 'a.txt')).status).toBe(401);
      expect((await request(env.built.app).get(`/api/v1/${p}/${crypto.randomUUID()}`)).status).toBe(401);
    }
    expect((await request(env.built.app).get('/api/admin/metadata/status')).status).toBe(401);
    expect((await request(env.built.app).post('/api/admin/metadata/backfill').send({})).status).toBe(401);
    expect((await admin.agent.post('/api/admin/metadata/backfill').send({})).status).toBe(403); // CSRF required
  });
  it('reprocesses metadata on demand and via the controlled backfill', async () => {
    const res = await up('videos', crypto.randomBytes(3000), 'later.mpg');
    expect(res.body.item.metadataStatus).toBe('unavailable');
    const again = await request(env.built.app).post(`/api/v1/videos/${res.body.item.id}/reprocess`).set('Authorization', `Bearer ${key}`);
    expect(again.status).toBe(200); expect(again.body.item.metadataStatus).toBe('unavailable');
    const st = await admin.agent.get('/api/admin/metadata/status');
    expect(st.body.tools.ffprobe.available).toBe(false); expect(st.body.tools.builtinParser.available).toBe(true);
    expect(st.body.counts.video.unavailable).toBeGreaterThanOrEqual(1);
    const fresh = await up('videos', craftMp4({ seconds: 8, width: 640, height: 480 }), 'bf.mp4');
    env.built.ctx.db.prepare("UPDATE videos SET metadata_status='pending', duration_seconds=NULL, width=NULL, height=NULL WHERE id = ?").run(fresh.body.item.id);
    const run = await admin.agent.post('/api/admin/metadata/backfill').set('X-CSRF-Token', admin.csrf).send({ scope: 'pending', mediaType: 'video' });
    expect(run.body).toMatchObject({ success: true, started: true, queued: 1 });
    await env.built.ctx.metadata.promise;
    const done = await request(env.built.app).get(`/api/v1/videos/${fresh.body.item.id}`).set('Authorization', `Bearer ${key}`);
    expect(done.body.item).toMatchObject({ metadataStatus: 'ready', durationSeconds: 8, width: 640, height: 480, aspectRatio: '4:3' });
    expect((await admin.agent.post('/api/admin/metadata/backfill').set('X-CSRF-Token', admin.csrf).send({ scope: 'bogus' })).status).toBe(400);
    expect((await admin.agent.post('/api/admin/videos/' + (await up('files', Buffer.from('x'), 'f.txt')).body.item.id + '/reprocess').set('X-CSRF-Token', admin.csrf)).status).toBe(400);
  });
  it('reports per-library counts and metadata health in the overview and diagnostics', async () => {
    const o = await admin.agent.get('/api/admin/overview');
    expect(o.body.media.video.total).toBeGreaterThan(5); expect(o.body.media.image.total).toBeGreaterThan(5); expect(o.body.media.file.total).toBeGreaterThan(5);
    expect(o.body.totals.total).toBe(o.body.media.video.total); // "videos" totals keep their old meaning
    const d = await admin.agent.get('/api/admin/diagnostics');
    expect(d.body.metadata.tools.ffprobe.available).toBe(false);
    expect(d.body.messages.some((m: { text: string }) => /FFprobe is not installed/.test(m.text))).toBe(true);
    const s = await admin.agent.get('/api/admin/storage');
    expect(s.body.orphans.missingFiles).toEqual([]); expect(s.body.orphans.unknownFiles).toEqual([]);
  });
  it('enforces the shared upload size limit and field name on all libraries', async () => {
    await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ maxUploadBytes: 1024 * 1024 });
    for (const kind of ['images', 'files', 'videos'] as const) {
      const buf = kind === 'videos' ? makeMp4(1024 * 1024 + 4096) : kind === 'images' ? Buffer.concat([craftPng(5, 5), crypto.randomBytes(1024 * 1024 + 100)]) : crypto.randomBytes(1024 * 1024 + 100);
      const r = await up(kind, buf, kind === 'videos' ? 'big.mp4' : kind === 'images' ? 'big.png' : 'big.bin');
      expect(r.status, kind).toBe(413); expect(r.body.error.code).toBe('file_too_large');
    }
    const wrong = await request(env.built.app).post('/api/v1/images').set('Authorization', `Bearer ${key}`).attach('picture', craftPng(5, 5), 'a.png');
    expect(wrong.status).toBe(400); expect(wrong.body.error.code).toBe('unexpected_field');
    expect(fs.readdirSync(env.built.ctx.config.dirs.temp)).toHaveLength(0);
    await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ maxUploadBytes: 1024 ** 3 });
  });
  it('supports idempotency across libraries without mixing them up', async () => {
    const k = 'idem-media-' + crypto.randomUUID();
    const a = await up('images', craftPng(8, 8), 'i.png').set('Idempotency-Key', k);
    const b = await up('images', craftPng(8, 8), 'i.png').set('Idempotency-Key', k);
    expect(a.status).toBe(201); expect(b.status).toBe(200); expect(b.body.item.id).toBe(a.body.item.id);
    const c = await up('files', Buffer.from('x'), 'i.txt').set('Idempotency-Key', k);
    expect(c.status).toBe(409);
  });
});

describe('file delivery stays memory-safe for big files', () => {
  it('streams a large file upload through a temp file and serves it back with ranges', async () => {
    const size = 24 * 1024 * 1024;
    const buf = crypto.randomBytes(size);
    const res = await up('files', buf, 'large.bin');
    expect(res.status).toBe(201);
    expect(res.body.item.sha256).toBe(sha256(buf));
    const tail = await request(env.built.app).get(pathOf(res.body.publicUrl)).set('Range', `bytes=${size - 1000}-`).buffer(true).parse(binary);
    expect(tail.status).toBe(206); expect(tail.body.equals(buf.subarray(size - 1000))).toBe(true);
    expect(fs.readdirSync(env.built.ctx.config.dirs.temp)).toHaveLength(0);
  });
});
