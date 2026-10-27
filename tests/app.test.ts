import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, createKey, login, makeMp4, makeWebm, PASSWORD, setupAdmin, sha256, USER, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Awaited<ReturnType<typeof setupAdmin>>;
let key: string;
let keyId: string;
let setupToken: string;

const upload = (k: string | null, buf: Buffer, filename = 'clip.mp4', field = 'data', ctype = 'video/mp4') => {
  const r = request(env.built.app).post('/api/v1/videos');
  if (k) r.set('Authorization', `Bearer ${k}`);
  return r.attach(field, buf, { filename, contentType: ctype });
};
const csrfPost = (p: string, body: object = {}, a = admin) => a.agent.post(`/api/admin${p}`).set('X-CSRF-Token', a.csrf).send(body);

beforeAll(async () => {
  env = createEnv();
  // 1. fresh database initialises
  const tables = (env.built.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of ['admins', 'sessions', 'api_keys', 'videos', 'settings', 'audit_events', 'schema_migrations']) expect(tables).toContain(t);
  expect((env.built.ctx.db.prepare('SELECT COUNT(*) c FROM videos').get() as { c: number }).c).toBe(0);
  const s = await request(env.built.app).get('/api/admin/session');
  expect(s.body.setupRequired).toBe(true);
  setupToken = fs.readFileSync(env.built.ctx.config.setupTokenPath, 'utf8').trim();
  // 2. first-run setup (negative cases first)
  expect((await request(env.built.app).post('/api/admin/setup').send({ token: 'x'.repeat(40), username: USER, password: PASSWORD })).status).toBe(403);
  expect((await request(env.built.app).post('/api/admin/setup').send({ token: setupToken, username: USER, password: 'short' })).status).toBe(400);
  admin = await setupAdmin(env);
  ({ key, id: keyId } = await createKey(admin));
});
afterAll(() => env.cleanup());

describe('setup & authentication', () => {
  it('disables setup after success and removes the token file', async () => {
    expect(fs.existsSync(env.built.ctx.config.setupTokenPath)).toBe(false);
    const again = await request(env.built.app).post('/api/admin/setup').send({ token: setupToken, username: 'other_admin', password: PASSWORD });
    expect(again.status).toBe(409);
    expect((await request(env.built.app).get('/api/admin/session')).body.setupRequired).toBe(false);
  });
  it('stores a password hash, not the password', () => {
    const row = env.built.ctx.db.prepare('SELECT password_hash FROM admins').get() as { password_hash: string };
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    expect(row.password_hash).not.toContain(PASSWORD);
  });
  it('rejects invalid credentials and logs the failure without the password', async () => {
    const bad = await request(env.built.app).post('/api/admin/login').send({ username: USER, password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_credentials');
    const unknown = await request(env.built.app).post('/api/admin/login').send({ username: 'nobody', password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    const ev = env.built.ctx.db.prepare("SELECT metadata FROM audit_events WHERE type = 'login_failed'").all() as { metadata: string }[];
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(ev)).not.toContain('wrong-password-123');
  });
  it('sets an HttpOnly SameSite cookie and rotates the session on login', async () => {
    const res = await request(env.built.app).post('/api/admin/login').send({ username: USER, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/lvh_sid=/); expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Strict/i);
    const second = await request(env.built.app).post('/api/admin/login').set('Cookie', cookie.split(';')[0]).send({ username: USER, password: PASSWORD });
    expect(String(second.headers['set-cookie'])).not.toContain(cookie.split(';')[0]);
    const old = await request(env.built.app).get('/api/admin/overview').set('Cookie', cookie.split(';')[0]);
    expect(old.status).toBe(401); // the pre-login session was discarded
  });
  it('requires authentication for the dashboard API', async () => {
    for (const p of ['/overview', '/videos', '/api-keys', '/settings', '/logs', '/storage', '/diagnostics']) {
      expect((await request(env.built.app).get(`/api/admin${p}`)).status, p).toBe(401);
    }
    expect((await request(env.built.app).post('/api/admin/api-keys').send({ label: 'x' })).status).toBe(401);
  });
  it('rate limits sign-in attempts', async () => {
    const e2 = createEnv({ rateLimits: { loginMax: 3, loginWindowMs: 60_000, setupMax: 100, uploadMax: 100, uploadWindowMs: 60_000, adminMax: 1000 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await request(e2.built.app).post('/api/admin/login').send({ username: 'a', password: 'b' })).status);
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes[3]).toBe(429);
    } finally { e2.cleanup(); }
  });
});

describe('CSRF and origin protection', () => {
  it('rejects state-changing admin requests without a CSRF token', async () => {
    const r = await admin.agent.post('/api/admin/api-keys').send({ label: 'no-csrf' });
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('csrf_failed');
    const w = await admin.agent.post('/api/admin/api-keys').set('X-CSRF-Token', 'wrong').send({ label: 'bad-csrf' });
    expect(w.status).toBe(403);
  });
  it('rejects requests from a foreign origin even with a valid token', async () => {
    const r = await admin.agent.post('/api/admin/api-keys').set('Origin', 'https://evil.example').set('X-CSRF-Token', admin.csrf).send({ label: 'x' });
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('bad_origin');
    const ok = await admin.agent.post('/api/admin/api-keys').set('Origin', 'http://localhost:3000').set('X-CSRF-Token', admin.csrf).send({ label: 'same-origin-label' });
    expect([201, 403]).toContain(ok.status); // host header is 127.0.0.1:<port> in tests; public origin is localhost:3000 -> allowed
    expect(ok.status).toBe(201);
  });
});

describe('uploading', () => {
  it('rejects uploads without a valid API key', async () => {
    const mp4 = makeMp4();
    expect((await upload(null, mp4)).status).toBe(401);
    const bad = await upload('lvh_deadbeef_notarealkey', mp4);
    expect(bad.status).toBe(401); expect(bad.body.error.code).toBe('invalid_api_key');
    expect(bad.body.success).toBe(false);
  });

  it('accepts an authenticated multipart upload and returns an n8n-friendly response', async () => {
    const mp4 = makeMp4(50_000);
    const res = await upload(key, mp4, 'My Video.mp4');
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.publicUrl).toBe(res.body.item.publicUrl);
    expect(res.body.item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.publicUrl).toBe(`http://localhost:3000/videos/${res.body.item.id}.mp4`);
    expect(res.body.item.downloadUrl).toBe(`${res.body.publicUrl}?download=1`);
    expect(res.body.item).toMatchObject({ originalName: 'My Video.mp4', mimeType: 'video/mp4', size: mp4.length, sha256: sha256(mp4), status: 'active' });
    expect(JSON.stringify(res.body)).not.toMatch(/uploads[\\/]/);
    const row = env.built.ctx.db.prepare('SELECT * FROM videos WHERE id = ?').get(res.body.item.id) as { storage_name: string; size: number };
    expect(row.size).toBe(mp4.length);
    expect(fs.readFileSync(path.join(env.built.ctx.config.dirs.uploads, row.storage_name)).equals(mp4)).toBe(true);
    expect(fs.readdirSync(env.built.ctx.config.dirs.temp)).toHaveLength(0);
  });

  it('gives identical filenames and identical content independent IDs without overwriting', async () => {
    const a = makeMp4(9000), b = makeMp4(9500);
    const [r1, r2, r3] = await Promise.all([upload(key, a, 'same.mp4'), upload(key, b, 'same.mp4'), upload(key, a, 'same.mp4')]);
    const ids = [r1, r2, r3].map((r) => r.body.item.id);
    expect(new Set(ids).size).toBe(3);
    const g1 = await request(env.built.app).get(new URL(r1.body.publicUrl).pathname).buffer(true).parse(binary);
    const g2 = await request(env.built.app).get(new URL(r2.body.publicUrl).pathname).buffer(true).parse(binary);
    expect(sha256(g1.body)).toBe(sha256(a)); expect(sha256(g2.body)).toBe(sha256(b));
    const count = (env.built.ctx.db.prepare('SELECT COUNT(DISTINCT storage_name) c FROM videos WHERE id IN (?,?,?)').get(...ids) as { c: number }).c;
    expect(count).toBe(3);
  });

  it('handles many concurrent uploads without mixing data', async () => {
    const files = Array.from({ length: 8 }, (_, i) => makeMp4(20_000 + i * 777));
    const results = await Promise.all(files.map((f) => upload(key, f, 'burst.mp4')));
    for (let i = 0; i < files.length; i++) {
      expect(results[i].status).toBe(201);
      expect(results[i].body.item.sha256).toBe(sha256(files[i]));
      const g = await request(env.built.app).get(new URL(results[i].body.publicUrl).pathname).buffer(true).parse(binary);
      expect(sha256(g.body)).toBe(sha256(files[i]));
    }
  });

  it('accepts WebM and sniffs the type from content', async () => {
    const res = await upload(key, makeWebm(), 'noext');
    expect(res.status).toBe(201);
    expect(res.body.item.mimeType).toBe('video/webm');
    expect(res.body.publicUrl.endsWith('.webm')).toBe(true);
  });

  it('streams the upload to a temp file on disk while it is still in flight', async () => {
    const server = http.createServer(env.built.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const boundary = '----lvhtest' + crypto.randomUUID();
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="big.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const head = makeMp4(1024);
    const chunk = crypto.randomBytes(1024 * 1024);
    const chunks = 48; // ~48 MB
    const hash = crypto.createHash('sha256').update(head);
    for (let i = 0; i < chunks; i++) hash.update(chunk);
    const total = head.length + chunk.length * chunks;
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/v1/videos', headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': pre.length + total + post.length } });
    const done = new Promise<{ status: number; body: any }>((resolve, reject) => {
      req.on('response', (res) => { const bufs: Buffer[] = []; res.on('data', (d) => bufs.push(d)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(bufs).toString()) })); });
      req.on('error', reject);
    });
    const write = (b: Buffer) => new Promise<void>((r) => { if (req.write(b)) r(); else req.once('drain', r); });
    await write(pre); await write(head);
    for (let i = 0; i < 24; i++) await write(chunk);
    // Half of the file has been sent: the bytes must already be on disk in the temp directory.
    let partSize = 0;
    for (let i = 0; i < 100 && partSize < 8 * 1024 * 1024; i++) {
      const parts = fs.readdirSync(env.built.ctx.config.dirs.temp).filter((f) => f.endsWith('.part'));
      partSize = parts.length ? fs.statSync(path.join(env.built.ctx.config.dirs.temp, parts[0])).size : 0;
      if (partSize < 8 * 1024 * 1024) await new Promise((r) => setTimeout(r, 50));
    }
    expect(partSize).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    for (let i = 24; i < chunks; i++) await write(chunk);
    req.end(post);
    const res = await done;
    server.close();
    expect(res.status).toBe(201);
    expect(res.body.item.size).toBe(total);
    expect(res.body.item.sha256).toBe(hash.digest('hex'));
    expect(fs.readdirSync(env.built.ctx.config.dirs.temp)).toHaveLength(0);
  });

  it('rejects invalid and unsupported files with actionable errors', async () => {
    const text = await upload(key, Buffer.from('<html>definitely not a video</html>'.repeat(20)), 'fake.mp4', 'data', 'video/mp4');
    expect(text.status).toBe(415); expect(text.body.error.code).toBe('unsupported_media_type');
    const html = await upload(key, makeMp4(), 'x.mp4', 'data', 'text/html');
    expect(html.status).toBe(415);
    const mismatch = await upload(key, makeWebm(), 'actually-webm.mp4', 'data', 'video/mp4');
    expect(mismatch.status).toBe(415);
    const wrongField = await upload(key, makeMp4(), 'a.mp4', 'file');
    expect(wrongField.status).toBe(400); expect(wrongField.body.error.code).toBe('unexpected_field'); expect(wrongField.body.error.message).toContain('"data"');
    const empty = await upload(key, Buffer.alloc(0), 'empty.mp4');
    expect(empty.status).toBe(400);
    const json = await request(env.built.app).post('/api/v1/videos').set('Authorization', `Bearer ${key}`).send({ hello: 'world' });
    expect(json.status).toBe(415); expect(json.body.error.code).toBe('unsupported_content_type');
    const noFile = await request(env.built.app).post('/api/v1/videos').set('Authorization', `Bearer ${key}`).field('note', 'hi');
    expect(noFile.status).toBe(400); expect(noFile.body.error.code).toBe('missing_file');
    expect(fs.readdirSync(env.built.ctx.config.dirs.temp)).toHaveLength(0);
    expect(JSON.stringify([text.body, wrongField.body])).not.toMatch(/Error:|at .*\(.*:\d+:\d+\)/);
  });

  it('enforces the configured size limit and cleans up', async () => {
    expect((await csrfPost('/settings', {})).status).toBe(404); // sanity: PUT only
    const put = await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ maxUploadBytes: 1024 * 1024 });
    expect(put.status).toBe(200);
    const big = await upload(key, makeMp4(1024 * 1024 + 4096));
    expect(big.status).toBe(413); expect(big.body.error.code).toBe('file_too_large');
    const ok = await upload(key, makeMp4(1024 * 1024 - 4096));
    expect(ok.status).toBe(201);
    expect(fs.readdirSync(env.built.ctx.config.dirs.temp)).toHaveLength(0);
    await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ maxUploadBytes: 1024 ** 3 });
  });

  it('supports scoped idempotency keys', async () => {
    const f = makeMp4(7000);
    const k = 'retry-key-' + crypto.randomUUID();
    const first = await upload(key, f).set('Idempotency-Key', k);
    const replay = await upload(key, f).set('Idempotency-Key', k);
    expect(first.status).toBe(201); expect(replay.status).toBe(200);
    expect(replay.body.item.id).toBe(first.body.item.id); expect(replay.body.idempotentReplay).toBe(true);
    const other = await upload(key, f).set('Idempotency-Key', 'another-' + crypto.randomUUID());
    expect(other.body.item.id).not.toBe(first.body.item.id);
  });
});

const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };

describe('public video URLs', () => {
  let id: string, url: string, data: Buffer;
  beforeAll(async () => {
    data = makeMp4(100_000);
    const r = await upload(key, data, 'public.mp4');
    id = r.body.item.id; url = new URL(r.body.publicUrl).pathname;
  });

  it('serves the exact bytes with the right headers without any authentication', async () => {
    const res = await request(env.built.app).get(url).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe(String(data.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers.etag).toBe(`"${sha256(data)}"`);
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.equals(data)).toBe(true);
  });
  it('supports download=1', async () => {
    const res = await request(env.built.app).get(`${url}?download=1`).buffer(true).parse(binary);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="public\.mp4"/);
  });
  it('answers HEAD with metadata and no body', async () => {
    const res = await request(env.built.app).head(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4'); expect(res.headers['content-length']).toBe(String(data.length));
    expect(res.text ?? '').toBe('');
  });
  it('serves byte ranges with 206 and correct headers', async () => {
    const r1 = await request(env.built.app).get(url).set('Range', 'bytes=10-109').buffer(true).parse(binary);
    expect(r1.status).toBe(206);
    expect(r1.headers['content-range']).toBe(`bytes 10-109/${data.length}`);
    expect(r1.headers['content-length']).toBe('100');
    expect(r1.body.equals(data.subarray(10, 110))).toBe(true);
    const r2 = await request(env.built.app).get(url).set('Range', 'bytes=-500').buffer(true).parse(binary);
    expect(r2.status).toBe(206); expect(r2.body.equals(data.subarray(data.length - 500))).toBe(true);
    const r3 = await request(env.built.app).get(url).set('Range', `bytes=${data.length - 10}-`).buffer(true).parse(binary);
    expect(r3.status).toBe(206); expect(r3.headers['content-range']).toBe(`bytes ${data.length - 10}-${data.length - 1}/${data.length}`);
    const r4 = await request(env.built.app).get(url).set('Range', `bytes=0-${data.length * 5}`).buffer(true).parse(binary);
    expect(r4.status).toBe(206); expect(r4.headers['content-range']).toBe(`bytes 0-${data.length - 1}/${data.length}`);
  });
  it('rejects unsatisfiable ranges with 416 and honours If-Range / conditional requests', async () => {
    const bad = await request(env.built.app).get(url).set('Range', `bytes=${data.length + 5}-`);
    expect(bad.status).toBe(416); expect(bad.headers['content-range']).toBe(`bytes */${data.length}`);
    const stale = await request(env.built.app).get(url).set('Range', 'bytes=0-9').set('If-Range', '"stale-etag"').buffer(true).parse(binary);
    expect(stale.status).toBe(200); expect(stale.body.length).toBe(data.length);
    const fresh = await request(env.built.app).get(url).set('Range', 'bytes=0-9').set('If-Range', `"${sha256(data)}"`).buffer(true).parse(binary);
    expect(fresh.status).toBe(206);
    const cached = await request(env.built.app).get(url).set('If-None-Match', `"${sha256(data)}"`);
    expect(cached.status).toBe(304);
  });
  it('never reveals other files for invalid, missing or traversal-style IDs', async () => {
    const attempts = ['/videos/../data/app.db', '/videos/..%2f..%2fpackage.json', '/videos/%2e%2e%2fpackage.json', '/videos/nonexistent', `/videos/${crypto.randomUUID()}.mp4`, `/videos/${id}.webm`, `/videos/${id}.mp4/..`, '/videos/', '/videos', '/videos/..\\..\\package.json'];
    for (const a of attempts) {
      const res = await request(env.built.app).get(a);
      expect([404, 400, 405], a).toContain(res.status);
      expect(res.headers['content-type'] ?? '', a).not.toMatch(/video\//);
      expect(res.text ?? '', a).not.toContain('"scripts"'); // never the contents of package.json or the database
      if (a.includes('..') && !a.includes('\\')) expect(res.headers['content-type'] ?? '', a).not.toMatch(/html/);
    }
  });
  it('is unavailable while trashed, and restoring keeps the same ID and URL', async () => {
    const t = await csrfPost('/videos/trash', { ids: [id] });
    expect(t.body.succeeded).toBe(1);
    const gone = await request(env.built.app).get(url);
    expect(gone.status).toBe(410); expect(gone.headers['content-type']).toMatch(/json/);
    expect((await request(env.built.app).head(url)).status).toBe(410);
    const row = env.built.ctx.db.prepare('SELECT storage_name, status FROM videos WHERE id = ?').get(id) as { storage_name: string; status: string };
    expect(row.status).toBe('trashed');
    expect(fs.existsSync(path.join(env.built.ctx.config.dirs.trash, row.storage_name))).toBe(true);
    expect(fs.existsSync(path.join(env.built.ctx.config.dirs.uploads, row.storage_name))).toBe(false);
    const r = await csrfPost('/videos/restore', { ids: [id] });
    expect(r.body.succeeded).toBe(1);
    const back = await request(env.built.app).get(url).buffer(true).parse(binary);
    expect(back.status).toBe(200); expect(back.body.equals(data)).toBe(true);
  });
  it('permanently deletes the file and record, only from the trash', async () => {
    const early = await csrfPost('/videos/delete', { ids: [id] });
    expect(early.body.results[0]).toMatchObject({ ok: false, error: 'not_trashed' }); // active videos can never be purged directly
    await csrfPost('/videos/trash', { ids: [id] });
    const row = env.built.ctx.db.prepare('SELECT storage_name FROM videos WHERE id = ?').get(id) as { storage_name: string };
    const del = await csrfPost('/videos/delete', { ids: [id] });
    expect(del.body.succeeded).toBe(1);
    expect(env.built.ctx.db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id)).toBeUndefined();
    expect(fs.existsSync(path.join(env.built.ctx.config.dirs.trash, row.storage_name))).toBe(false);
    expect((await request(env.built.app).get(url)).status).toBe(404);
  });
  it('empties the trash only with explicit confirmation', async () => {
    const r = await upload(key, makeMp4(3000), 'to-empty.mp4');
    await csrfPost('/videos/trash', { ids: [r.body.item.id] });
    expect((await csrfPost('/trash/empty', {})).status).toBe(400);
    const out = await csrfPost('/trash/empty', { confirm: 'EMPTY TRASH' });
    expect(out.status).toBe(200); expect(out.body.succeeded).toBeGreaterThanOrEqual(1);
    expect((env.built.ctx.db.prepare("SELECT COUNT(*) c FROM videos WHERE status='trashed'").get() as { c: number }).c).toBe(0);
  });
});

describe('library, API keys, settings, logs', () => {
  it('lists, searches, sorts and paginates on the server', async () => {
    const list = await admin.agent.get('/api/admin/videos?page=1&pageSize=3&sort=size&order=asc');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeLessThanOrEqual(3); expect(list.body.totalPages).toBeGreaterThan(1);
    const sizes = list.body.items.map((i: { size: number }) => i.size);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    const search = await admin.agent.get('/api/admin/videos?q=My%20Video');
    expect(search.body.items.every((i: { originalName: string }) => i.originalName.includes('My Video'))).toBe(true);
    const byId = await admin.agent.get(`/api/admin/videos?q=${list.body.items[0].id.slice(0, 8)}`);
    expect(byId.body.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list.body)).not.toMatch(/storage_name|[A-Za-z]:\\|\/storage\//);
  });
  it('stores only a hash of API keys and never returns the key again', async () => {
    const created = await createKey(admin, 'hash-check');
    const dump = JSON.stringify(env.built.ctx.db.prepare('SELECT * FROM api_keys').all()) + JSON.stringify(env.built.ctx.db.prepare('SELECT * FROM audit_events').all());
    expect(dump).not.toContain(created.key);
    const listed = await admin.agent.get('/api/admin/api-keys');
    expect(JSON.stringify(listed.body)).not.toContain(created.key);
    expect(JSON.stringify(listed.body)).not.toMatch(/key_hash/);
  });
  it('revokes keys immediately', async () => {
    const k = await createKey(admin, 'to-revoke');
    expect((await upload(k.key, makeMp4())).status).toBe(201);
    expect((await csrfPost(`/api-keys/${k.id}/revoke`)).status).toBe(200);
    const after = await upload(k.key, makeMp4());
    expect(after.status).toBe(401); expect(after.body.error.code).toBe('revoked_api_key');
    expect((await upload(key, makeMp4())).status).toBe(201); // other keys unaffected
  });
  it('rejects invalid public base URLs and applies a new one to future responses', async () => {
    for (const bad of ['not a url', 'javascript:alert(1)', 'ftp://media.example.com', 'https://user:pw@media.example.com', 'https://media.example.com/path', 'https://media.example.com/?q=1', '']) {
      const r = await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ publicBaseUrl: bad });
      expect(r.status, bad).toBe(400);
    }
    const ok = await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ publicBaseUrl: 'https://media.example.com/' });
    expect(ok.status).toBe(200); expect(ok.body.settings.publicBaseUrl).toBe('https://media.example.com');
    const res = await upload(key, makeMp4());
    expect(res.body.publicUrl).toMatch(/^https:\/\/media\.example\.com\/videos\/[0-9a-f-]{36}\.mp4$/);
    // the Host header must never influence generated links
    const spoof = await request(env.built.app).post('/api/v1/videos').set('Host', 'attacker.example').set('Authorization', `Bearer ${key}`).attach('data', makeMp4(), { filename: 'a.mp4', contentType: 'video/mp4' });
    expect(spoof.body.publicUrl).toMatch(/^https:\/\/media\.example\.com\//);
    await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ publicBaseUrl: 'http://localhost:3000' });
  });
  it('rejects invalid settings values', async () => {
    for (const body of [{ maxUploadBytes: 5 }, { allowedTypes: ['exe'] }, { allowedTypes: [] }, { fieldName: 'bad name!' }, { timeZone: 'Mars/Base' }, { unknownKey: 1 }]) {
      expect((await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
  it('records activity without secrets and supports filtering', async () => {
    const all = await admin.agent.get('/api/admin/logs?pageSize=200');
    const types = new Set(all.body.items.map((e: { type: string }) => e.type));
    for (const t of ['setup_completed', 'video_uploaded', 'upload_failed', 'video_trashed', 'video_restored', 'video_deleted', 'api_key_created', 'api_key_revoked', 'settings_changed', 'login_failed', 'login_success']) expect(types, t).toContain(t);
    const logFile = path.join(env.built.ctx.config.dirs.logs, 'app.log');
    const dump = JSON.stringify(all.body) + (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
    expect(dump).not.toContain(PASSWORD); expect(dump).not.toContain(key); expect(dump).not.toContain(setupToken);
    const filtered = await admin.agent.get('/api/admin/logs?type=video_uploaded');
    expect(filtered.body.items.every((e: { type: string }) => e.type === 'video_uploaded')).toBe(true);
    const search = await admin.agent.get(`/api/admin/logs?q=${encodeURIComponent('My Video.mp4')}`);
    expect(search.body.total).toBeGreaterThanOrEqual(1);
  });
  it('reports real overview, storage and diagnostics data', async () => {
    const o = await admin.agent.get('/api/admin/overview');
    expect(o.body.totals.total).toBe((env.built.ctx.db.prepare('SELECT COUNT(*) c FROM videos').get() as { c: number }).c);
    expect(o.body.totals.uploadsToday).toBeGreaterThan(0);
    const s = await admin.agent.get('/api/admin/storage');
    expect(s.body.directories.map((d: { name: string }) => d.name)).toEqual(['uploads', 'trash', 'temp', 'database', 'logs']);
    expect(s.body.directories.every((d: { writable: boolean; exists: boolean }) => d.writable && d.exists)).toBe(true);
    const up = s.body.directories.find((d: { name: string }) => d.name === 'uploads');
    expect(up.fileCount).toBe((env.built.ctx.db.prepare("SELECT COUNT(*) c FROM videos WHERE status='active'").get() as { c: number }).c);
    const d = await admin.agent.get('/api/admin/diagnostics');
    expect(d.body.database.ok).toBe(true);
  });
  it('cleans abandoned temp files but keeps in-flight ones', async () => {
    const stale = path.join(env.built.ctx.config.dirs.temp, 'stale.part');
    fs.writeFileSync(stale, 'x'); const old = new Date(Date.now() - 3 * 3600_000); fs.utimesSync(stale, old, old);
    const live = path.join(env.built.ctx.config.dirs.temp, 'live.part');
    fs.writeFileSync(live, 'x'); fs.utimesSync(live, old, old); env.built.ctx.activeTemps.add(live);
    const r = await csrfPost('/storage/cleanup-temp', { olderThanMinutes: 60 });
    expect(r.body.removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false); expect(fs.existsSync(live)).toBe(true);
    env.built.ctx.activeTemps.delete(live); fs.unlinkSync(live);
  });
  it('changing the password invalidates other sessions', async () => {
    const other = await login(env);
    expect((await other.agent.get('/api/admin/overview')).status).toBe(200);
    const r = await admin.agent.post('/api/admin/change-password').set('X-CSRF-Token', admin.csrf).send({ currentPassword: PASSWORD, newPassword: PASSWORD + '-new' });
    expect(r.status).toBe(200);
    expect((await other.agent.get('/api/admin/overview')).status).toBe(401);
    admin.csrf = r.body.csrfToken;
    expect((await admin.agent.get('/api/admin/overview')).status).toBe(200);
    const back = await admin.agent.post('/api/admin/change-password').set('X-CSRF-Token', admin.csrf).send({ currentPassword: PASSWORD + '-new', newPassword: PASSWORD });
    admin.csrf = back.body.csrfToken;
  });
});

describe('health and persistence', () => {
  it('exposes only minimal health information', async () => {
    const res = await request(env.built.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['app', 'status', 'time']);
  });
  it('has unknown API routes return JSON 404', async () => {
    const res = await request(env.built.app).get('/api/nope');
    expect(res.status).toBe(404); expect(res.body.success).toBe(false);
  });
  it('keeps metadata, videos and admin login across a restart', async () => {
    const r = await upload(key, makeMp4(5000), 'persist.mp4');
    const before = (env.built.ctx.db.prepare('SELECT COUNT(*) c FROM videos').get() as { c: number }).c;
    env.built.close();
    const restarted = createEnv(env.config, env.root);
    try {
      expect((restarted.built.ctx.db.prepare('SELECT COUNT(*) c FROM videos').get() as { c: number }).c).toBe(before);
      const g = await request(restarted.built.app).get(new URL(r.body.publicUrl).pathname);
      expect(g.status).toBe(200);
      expect((await request(restarted.built.app).get('/api/admin/session')).body.setupRequired).toBe(false);
      expect((await login(restarted)).csrf).toBeTruthy();
      expect(fs.existsSync(restarted.built.ctx.config.setupTokenPath)).toBe(false);
      expect((await request(restarted.built.app).post('/api/v1/videos').set('Authorization', `Bearer ${key}`).attach('data', makeMp4(), { filename: 'z.mp4', contentType: 'video/mp4' })).status).toBe(201);
    } finally { restarted.built.close(); }
    env = createEnv(env.config, env.root); // let afterAll clean up
  });
});
void keyId;
