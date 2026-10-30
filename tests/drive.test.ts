import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveUrlError, parseDriveSource } from '../server/driveUrl';
import { loadKey, seal, unseal } from '../server/secretBox';
import { createEnv, createKey, setupAdmin, sha256, type TestEnv } from './helpers';
import { craftMp4, craftPng } from './fixtures';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const SECRET = 'GOCSPX-super-secret-client-value';
const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';

// ---------------- URL parsing ----------------
describe('Google Drive link parsing', () => {
  const ok: [string, string][] = [
    [`https://drive.google.com/file/d/${ID}/view`, ID], [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, ID], [`https://drive.google.com/file/d/${ID}/view?usp=drive_link`, ID],
    [`https://drive.google.com/file/d/${ID}/preview`, ID], [`https://drive.google.com/file/d/${ID}`, ID], [`https://drive.google.com/file/u/0/d/${ID}/view`, 'x'], [`https://drive.google.com/u/0/file/d/${ID}/view`, ID],
    [`https://drive.google.com/open?id=${ID}`, ID], [`https://drive.google.com/open?id=${ID}&usp=drive_fs`, ID], [`https://drive.google.com/uc?id=${ID}&export=download`, ID], [`https://drive.google.com/uc?export=download&id=${ID}`, ID],
    [`https://docs.google.com/document/d/${ID}/edit`, ID], [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, ID], [`https://docs.google.com/presentation/d/${ID}/edit`, ID],
    [ID, ID], [`  ${ID}\n`, ID], [`https://drive.google.com/a/example.com/file/d/${ID}/view`, ID],
  ];
  for (const [input, id] of ok) {
    it(`accepts ${input.slice(0, 70).trim()}`, () => {
      if (id === 'x') { expect(() => parseDriveSource(input)).toThrow(DriveUrlError); return; } // legacy path shape with the id in the wrong place is refused, not guessed
      expect(parseDriveSource(input).fileId).toBe(id);
    });
  }
  const bad = ['', '   ', 'abc', 'not a url', 'ftp://drive.google.com/file/d/' + ID, 'http://drive.google.com/file/d/' + ID + '/view', `https://evil.com/file/d/${ID}/view`, `https://drive.google.com.evil.com/file/d/${ID}/view`,
    `https://evil.com/?https://drive.google.com/file/d/${ID}/view`, `https://user:pw@drive.google.com/file/d/${ID}/view`, `https://drive.google.com:8443/file/d/${ID}/view`, `https://drive.google.com/file/d/short/view`,
    `https://drive.google.com/file/d/${ID}%00/view`, 'javascript:alert(1)', 'file:///etc/passwd', `https://drive.google.com/`, `https://drive.google.com/open`, `https://drive.google.com/open?id=`, `https://drive.google.com/open?id=../../x`,
    `https://drive.google.com/something/else/${ID}`, `https://docs.google.com/forms/d/${ID}/edit`, 'x'.repeat(5000), 'a/b', ID + '/../../etc'];
  for (const b of bad) it(`rejects ${JSON.stringify(b.slice(0, 60))}`, () => { expect(() => parseDriveSource(b)).toThrow(DriveUrlError); });
  it('recognises folder links with a dedicated error', () => {
    expect(() => parseDriveSource(`https://drive.google.com/drive/folders/${ID}`)).toThrowError(expect.objectContaining({ code: 'folder' }));
    expect(() => parseDriveSource(`https://drive.google.com/drive/u/0/folders/${ID}`)).toThrowError(expect.objectContaining({ code: 'folder' }));
    expect(() => parseDriveSource(123 as never)).toThrow(DriveUrlError);
  });
});

describe('credential encryption', () => {
  it('round-trips, uses a fresh IV, and detects tampering', () => {
    const key = crypto.randomBytes(32);
    const a = seal(key, SECRET), b = seal(key, SECRET);
    expect(a).not.toContain(SECRET); expect(a).not.toBe(b);
    expect(unseal(key, a)).toBe(SECRET);
    expect(() => unseal(key, a.slice(0, -3) + 'AAA')).toThrow();
    expect(() => unseal(crypto.randomBytes(32), a)).toThrow();
    expect(() => unseal(key, 'garbage')).toThrow();
  });
  it('creates a separate 0600-style key file and honours DRIVE_ENCRYPTION_KEY', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvh-key-'));
    try {
      const k1 = loadKey(dir, {}); expect(k1).toHaveLength(32);
      expect(fs.existsSync(path.join(dir, 'drive-encryption.key'))).toBe(true);
      expect(loadKey(dir, {}).equals(k1)).toBe(true);
      expect(loadKey(dir, { DRIVE_ENCRYPTION_KEY: 'a-long-enough-passphrase' }).equals(k1)).toBe(false);
      expect(() => loadKey(dir, { DRIVE_ENCRYPTION_KEY: 'short' })).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------- mocked Google ----------------
interface MockFile { meta: Record<string, unknown>; body?: () => BodyInit; contentType?: string; metaStatus?: number; mediaStatus?: number; reason?: string }
let env: TestEnv; let admin: Awaited<ReturnType<typeof setupAdmin>>; let key: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const files = new Map<string, MockFile>();
let calls: { url: string; method: string; auth: string | null; body: string }[] = [];
let refreshMode: 'ok' | 'invalid_grant' = 'ok';
let listResponse: { nextPageToken?: string; files: Record<string, unknown>[] } = { files: [] };
let tokenCounter = 0;

const stream = (chunks: Buffer[], opts: { errorAfter?: number; gate?: { chunk: number; wait: Promise<void> } } = {}) => () => {
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (opts.gate && i === opts.gate.chunk) await opts.gate.wait;
      if (opts.errorAfter !== undefined && i >= opts.errorAfter) return c.error(new Error('connection reset'));
      if (i >= chunks.length) return c.close();
      c.enqueue(new Uint8Array(chunks[i++]));
    },
  });
};
const bytes = (b: Buffer) => () => new Uint8Array(b) as unknown as BodyInit;
const driveFile = (over: Partial<Record<string, unknown>> = {}, b?: Buffer, extra: Partial<MockFile> = {}): MockFile =>
  ({ meta: { id: ID, name: 'clip.mp4', mimeType: 'video/mp4', size: b ? String(b.length) : '0', md5Checksum: crypto.createHash('md5').update(b ?? '').digest('hex'), modifiedTime: '2026-01-01T00:00:00Z', trashed: false, capabilities: { canDownload: true }, ...over }, body: b ? bytes(b) : undefined, ...extra });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function installMock() {
  fetchSpy.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.Authorization ?? null, body: init?.body ? String(init.body) : '' });
    if (!/^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com|www\.googleapis\.com)\//.test(url)) throw new Error('UNEXPECTED EXTERNAL REQUEST: ' + url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(String(init?.body));
      if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'good-code' && p.get('code_verifier') ? json({ access_token: `AT-${++tokenCounter}`, refresh_token: 'RT-SECRET-refresh', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
      if (p.get('grant_type') === 'refresh_token') return refreshMode === 'ok' ? json({ access_token: `AT-${++tokenCounter}`, expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('', { status: 200 });
    const u = new URL(url);
    if (u.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'owner@example.com', displayName: 'Owner' }, storageQuota: { limit: '1000', usage: '10' } });
    if (u.pathname === '/drive/v3/files') return json(listResponse);
    const m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(u.pathname);
    if (m) {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return json({ error: { code: 404, message: 'File not found' } }, 404);
      const isMedia = u.searchParams.get('alt') === 'media' || !!m[2];
      const status = isMedia ? f.mediaStatus ?? 200 : f.metaStatus ?? 200;
      if (status !== 200) return json({ error: { code: status, errors: [{ reason: f.reason ?? 'x' }] } }, status);
      if (!isMedia) return json(f.meta);
      return new Response(f.body?.(), { status: 200, headers: { 'content-type': f.contentType ?? String(f.meta.mimeType ?? 'application/octet-stream'), ...(f.meta.size && f.meta.size !== '0' ? { 'content-length': String(f.meta.size) } : {}) } });
    }
    return json({ error: 'unmocked ' + url }, 500);
  });
}
const mediaCalls = () => calls.filter((c) => /alt=media|\/export\?/.test(c.url));
const reachedDrive = () => calls.filter((c) => c.url.includes('googleapis.com/drive'));

async function connectDrive() {
  const put = await admin.agent.put('/api/admin/drive/config').set('X-CSRF-Token', admin.csrf).send({ clientId: CLIENT_ID, clientSecret: SECRET });
  expect(put.status).toBe(200);
  const c = await admin.agent.post('/api/admin/drive/connect').set('X-CSRF-Token', admin.csrf).send({});
  const state = new URL(c.body.authUrl).searchParams.get('state')!;
  const cb = await request(env.built.app).get(`/api/admin/drive/callback?code=good-code&state=${state}`); // no cookie: like the browser coming back from Google
  expect(cb.text).toContain('result=connected');
  return { authUrl: c.body.authUrl as string, state };
}

// Every test gets its own database, storage folders and download slots, so tests cannot influence each other.
beforeEach(async () => {
  env = createEnv(); admin = await setupAdmin(env); key = (await createKey(admin)).key;
  fetchSpy = vi.spyOn(globalThis, 'fetch'); calls = []; files.clear(); refreshMode = 'ok'; listResponse = { files: [] }; installMock();
});
afterEach(() => { fetchSpy.mockRestore(); vi.restoreAllMocks(); env.cleanup(); });

const imp = (body: object | string, kind = 'videos', k: string | null = key) => {
  const r = request(env.built.app).post(`/api/v1/${kind}`);
  if (k) r.set('Authorization', `Bearer ${k}`);
  return typeof body === 'string' ? r.set('Content-Type', 'application/json').send(body) : r.send(body);
};
const link = `https://drive.google.com/file/d/${ID}/view?usp=sharing`;
const tempFiles = () => fs.readdirSync(env.built.ctx.config.dirs.temp);
const uploadsCount = () => fs.readdirSync(env.built.ctx.config.dirs.uploads).length;
const videoRows = () => (env.built.ctx.db.prepare('SELECT COUNT(*) c FROM videos').get() as { c: number }).c;

describe('connecting a Google account', () => {
  it('requires admin authentication and CSRF for every Drive action', async () => {
    for (const [m, p] of [['get', '/drive/status'], ['get', '/drive/files'], ['get', `/drive/files/${ID}`], ['get', '/drive/imports'], ['put', '/drive/config'], ['post', '/drive/connect'], ['post', '/drive/test'], ['post', '/drive/disconnect'], ['post', '/drive/import']] as const) {
      expect((await request(env.built.app)[m](`/api/admin${p}`).send({})).status, `${m} ${p}`).toBe(401);
    }
    for (const [m, p] of [['put', '/drive/config'], ['post', '/drive/connect'], ['post', '/drive/test'], ['post', '/drive/disconnect'], ['post', '/drive/import']] as const) {
      expect((await admin.agent[m](`/api/admin${p}`).send({ clientId: CLIENT_ID })).status, `csrf ${m} ${p}`).toBe(403);
    }
  });

  it('starts as not configured, validates input, and needs credentials before connecting', async () => {
    expect((await admin.agent.get('/api/admin/drive/status')).body).toMatchObject({ status: 'not_configured', hasSecret: false, clientId: '' });
    expect((await admin.agent.post('/api/admin/drive/connect').set('X-CSRF-Token', admin.csrf).send({})).status).toBe(409);
    expect((await admin.agent.put('/api/admin/drive/config').set('X-CSRF-Token', admin.csrf).send({ clientId: 'x' })).status).toBe(400);
    expect((await admin.agent.put('/api/admin/drive/config').set('X-CSRF-Token', admin.csrf).send({ clientId: CLIENT_ID })).status).toBe(400); // secret required the first time
  });

  it('runs the OAuth flow with PKCE and one-time state, and stores everything encrypted', async () => {
    const { authUrl, state } = await connectDrive();
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: CLIENT_ID, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.readonly', access_type: 'offline', code_challenge_method: 'S256', redirect_uri: 'http://localhost:3000/api/admin/drive/callback' });
    expect(u.searchParams.get('code_challenge')!.length).toBeGreaterThan(40);
    const st = (await admin.agent.get('/api/admin/drive/status')).body;
    expect(st).toMatchObject({ status: 'connected', account: { email: 'owner@example.com' }, hasSecret: true, clientId: CLIENT_ID });
    // the state cannot be replayed
    const replay = await request(env.built.app).get(`/api/admin/drive/callback?code=good-code&state=${state}`);
    expect(replay.text).toContain('result=failed'); expect(replay.text).toContain('invalid_state');
    // nothing sensitive in plaintext: database, API responses, logs, audit
    const dump = JSON.stringify(env.built.ctx.db.prepare('SELECT * FROM kv').all()) + JSON.stringify(env.built.ctx.db.prepare('SELECT * FROM audit_events').all());
    for (const secret of [SECRET, 'RT-SECRET-refresh', 'AT-1', 'good-code']) expect(dump, secret).not.toContain(secret);
    expect(JSON.stringify(st)).not.toMatch(/SECRET|RT-|AT-/);
    const logFile = path.join(env.built.ctx.config.dirs.logs, 'app.log');
    if (fs.existsSync(logFile)) for (const secret of [SECRET, 'RT-SECRET-refresh']) expect(fs.readFileSync(logFile, 'utf8')).not.toContain(secret);
    expect(fs.existsSync(path.join(env.built.ctx.config.dataDir, 'drive-encryption.key'))).toBe(true);
    expect(calls.find((c) => c.url.includes('/token') && c.body.includes('authorization_code'))!.body).toContain('code_verifier=');
  });

  it('rejects forged, unknown and expired authorisation states', async () => {
    await admin.agent.put('/api/admin/drive/config').set('X-CSRF-Token', admin.csrf).send({ clientId: CLIENT_ID, clientSecret: SECRET });
    for (const q of ['code=good-code&state=forged', 'code=good-code', 'state=abc', 'code=' + 'x'.repeat(3000) + '&state=a', 'error=access_denied&state=x']) {
      const r = await request(env.built.app).get(`/api/admin/drive/callback?${q}`);
      expect(r.status).toBe(200); expect(r.text).toMatch(/result=(failed|denied)/); expect(r.text).not.toContain('good-code');
    }
    const c = await admin.agent.post('/api/admin/drive/connect').set('X-CSRF-Token', admin.csrf).send({});
    const state = new URL(c.body.authUrl).searchParams.get('state')!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    const late = await request(env.built.app).get(`/api/admin/drive/callback?code=good-code&state=${state}`);
    vi.restoreAllMocks(); installMock();
    expect(late.text).toContain('state_expired');
    expect((await admin.agent.get('/api/admin/drive/status')).body.status).not.toBe('connected');
  });

  it('tests the connection, and disconnects (revoking at Google and erasing tokens)', async () => {
    await connectDrive();
    const t = await admin.agent.post('/api/admin/drive/test').set('X-CSRF-Token', admin.csrf).send({});
    expect(t.body).toMatchObject({ success: true, ok: true, account: { email: 'owner@example.com' } });
    const d = await admin.agent.post('/api/admin/drive/disconnect').set('X-CSRF-Token', admin.csrf).send({});
    expect(d.body.status).toBe('disconnected');
    expect(calls.some((c) => c.url.includes('/revoke'))).toBe(true);
    expect(env.built.ctx.db.prepare("SELECT COUNT(*) c FROM kv WHERE key IN ('gdrive.refresh_token','gdrive.access_token')").get()).toEqual({ c: 0 });
    expect((await admin.agent.post('/api/admin/drive/test').set('X-CSRF-Token', admin.csrf).send({})).status).toBe(409);
    expect((await imp({ webViewLink: link })).body.error.code).toBe('drive_not_connected');
    await connectDrive(); // reconnect works
    expect((await admin.agent.get('/api/admin/drive/status')).body.status).toBe('connected');
  });
});

describe('browsing Google Drive from the dashboard', () => {
  beforeEach(async () => { await connectDrive(); calls = []; });

  it('lists folders and files with kinds, sizes, and page tokens', async () => {
    listResponse = { nextPageToken: 'NEXT-TOKEN_1', files: [
      { id: 'F0LDER0000000001', name: 'Projects', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-02T00:00:00Z' },
      { id: ID, name: 'clip.mp4', mimeType: 'video/mp4', size: '1048576', modifiedTime: '2026-01-03T00:00:00Z', webViewLink: link },
      { id: 'IMG0000000000001', name: 'p.png', mimeType: 'image/png', size: '2048' },
      { id: 'DOC0000000000001', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
      { id: 'FRM0000000000001', name: 'Form', mimeType: 'application/vnd.google-apps.form' },
      { id: 'SHORTCUT00000001', name: 'Link to folder', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'TARGETFOLDER0001', targetMimeType: 'application/vnd.google-apps.folder' } },
    ] };
    const r = await admin.agent.get('/api/admin/drive/files?pageSize=6');
    expect(r.status).toBe(200); expect(r.body.nextPageToken).toBe('NEXT-TOKEN_1');
    const by = Object.fromEntries(r.body.items.map((i: { name: string }) => [i.name, i]));
    expect(by.Projects).toMatchObject({ kind: 'folder', importable: false });
    expect(by['clip.mp4']).toMatchObject({ kind: 'video', library: 'video', size: 1048576, sizeFormatted: '1.0 MB', importable: true, webViewLink: link });
    expect(by['p.png']).toMatchObject({ kind: 'image', library: 'image' });
    expect(by.Notes).toMatchObject({ kind: 'document', library: 'file', exportsAs: 'pdf', importable: true });
    expect(by.Form).toMatchObject({ kind: 'unsupported', importable: false });
    expect(by['Link to folder']).toMatchObject({ kind: 'folder', id: 'TARGETFOLDER0001', isShortcut: true });
    const sent = new URL(reachedDrive().find((c) => c.url.includes('/files?'))!.url).searchParams;
    expect(sent.get('q')).toBe("trashed = false and 'root' in parents");
    expect(sent.get('pageSize')).toBe('6');
    expect(sent.get('fields')).not.toMatch(/thumbnail|permissions|owners\(emailAddress/);
    await admin.agent.get('/api/admin/drive/files?pageToken=NEXT-TOKEN_1&folderId=F0LDER0000000001');
    const p2 = new URL(reachedDrive().filter((c) => c.url.includes('/files?')).pop()!.url).searchParams;
    expect(p2.get('pageToken')).toBe('NEXT-TOKEN_1'); expect(p2.get('q')).toBe("trashed = false and 'F0LDER0000000001' in parents");
  });

  it('searches safely and supports "shared with me"', async () => {
    await admin.agent.get('/api/admin/drive/files?q=' + encodeURIComponent("it's a \\ test' or name contains '"));
    expect(new URL(reachedDrive().pop()!.url).searchParams.get('q')).toBe("trashed = false and name contains 'it\\'s a \\\\ test\\' or name contains \\''");
    await admin.agent.get('/api/admin/drive/files?mode=shared');
    expect(new URL(reachedDrive().pop()!.url).searchParams.get('q')).toBe('trashed = false and sharedWithMe = true');
  });

  it('validates folder IDs, tokens and sizes before talking to Google', async () => {
    const before = reachedDrive().length;
    for (const qs of ["folderId=x' or '1'='1", 'folderId=short', 'folderId=../../etc', 'pageSize=0', 'pageSize=1000', 'mode=everything', "pageToken=bad token'"]) {
      expect((await admin.agent.get(`/api/admin/drive/files?${qs}`)).status, qs).toBe(400);
    }
    expect(reachedDrive().length).toBe(before);
  });

  it('inspects a file and shows where it was already imported', async () => {
    const buf = craftMp4({ seconds: 5, width: 640, height: 360 });
    files.set(ID, driveFile({}, buf));
    const before = await admin.agent.get(`/api/admin/drive/files/${ID}`);
    expect(before.body.file).toMatchObject({ id: ID, name: 'clip.mp4', kind: 'video', library: 'video', canDownload: true }); expect(before.body.alreadyImported).toEqual([]);
    expect((await imp({ webViewLink: link })).status).toBe(201);
    const after = await admin.agent.get(`/api/admin/drive/files/${ID}`);
    expect(after.body.alreadyImported).toHaveLength(1); expect(after.body.alreadyImported[0].publicUrl).toMatch(/\/videos\//);
    expect((await admin.agent.get('/api/admin/drive/files/nope')).status).toBe(400);
  });

  it('reports permission and connection failures clearly', async () => {
    files.set(ID, driveFile({}, undefined, { metaStatus: 403, reason: 'insufficientFilePermissions' }));
    expect((await admin.agent.get(`/api/admin/drive/files/${ID}`)).body.error.code).toBe('drive_access_denied');
    expect((await admin.agent.get('/api/admin/drive/files/MISSING0000000000')).body.error.code).toBe('drive_file_not_found');
  });
});

describe('importing from Google Drive through the existing n8n endpoint', () => {
  beforeEach(async () => { await connectDrive(); calls = []; });
  const vid = craftMp4({ seconds: 95, width: 1080, height: 1920, audio: true, padTo: 300_000 });

  it('downloads the file with the Drive API and returns the normal upload response (publicUrl + item)', async () => {
    files.set(ID, driveFile({}, vid));
    const res = await imp({ webViewLink: link, name: 'clip.mp4', mimeType: 'video/mp4', id: ID });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ success: true, duplicate: false, source: { type: 'gdrive', fileId: ID } });
    expect(res.body.publicUrl).toBe(res.body.item.publicUrl);
    expect(res.body.publicUrl).toBe(`http://localhost:3000/videos/${res.body.item.id}.mp4`);
    expect(res.body.item.id).not.toBe(ID); // the OnePipePilot ID is not the Drive ID
    expect(res.body.item).toMatchObject({ mediaType: 'video', originalName: 'clip.mp4', mimeType: 'video/mp4', size: vid.length, sha256: sha256(vid), status: 'active', durationSeconds: 95, width: 1080, height: 1920, aspectRatio: '9:16', metadataStatus: 'ready' });
    const media = mediaCalls();
    expect(media).toHaveLength(1);
    expect(media[0].url).toContain(`/files/${ID}?alt=media`);
    expect(media[0].auth).toMatch(/^Bearer AT-/);
    expect(calls.every((c) => /googleapis\.com|google\.com/.test(c.url))).toBe(true);
    const row = env.built.ctx.db.prepare('SELECT * FROM videos WHERE id = ?').get(res.body.item.id) as Record<string, unknown>;
    expect(row).toMatchObject({ source_type: 'gdrive', source_id: ID, media_type: 'video', api_key_id: expect.any(String) });
    expect(fs.readFileSync(path.join(env.built.ctx.config.dirs.uploads, String(row.storage_name))).equals(vid)).toBe(true);
    const pub = await request(env.built.app).get(new URL(res.body.publicUrl).pathname).set('Range', 'bytes=10-109');
    expect(pub.status).toBe(206); expect(pub.headers['content-type']).toBe('video/mp4'); // existing public URL machinery, incl. ranges
    expect(tempFiles()).toEqual([]);
  });

  it('accepts the usual property names, nested items, a one-element array, form fields and bare file IDs', async () => {
    files.set(ID, driveFile({}, vid));
    const first = await imp({ webViewLink: link }); expect(first.status).toBe(201);
    const variants: [string, object | string, string?][] = [
      ['driveUrl', { driveUrl: link }], ['fileId', { fileId: ID }], ['driveFileId', { driveFileId: ID }], ['url', { url: link }], ['open?id', { webViewLink: `https://drive.google.com/open?id=${ID}` }],
      ['nested json', { json: { webViewLink: link } }], ['array of one', [{ webViewLink: link, kind: 'drive#file' }]], ['full n8n item', { id: ID, name: 'x', mimeType: 'video/mp4', webViewLink: link, webContentLink: 'https://drive.google.com/uc?id=' + ID, owners: [{}], parents: ['p'] }],
    ];
    for (const [label, body] of variants) { const r = await imp(body); expect(r.status, label).toBe(200); expect(r.body.duplicate, label).toBe(true); expect(r.body.item.id, label).toBe(first.body.item.id); }
    const form = await request(env.built.app).post('/api/v1/videos').set('Authorization', `Bearer ${key}`).field('webViewLink', link);
    expect(form.status).toBe(200); expect(form.body.item.id).toBe(first.body.item.id);
    const urlenc = await request(env.built.app).post('/api/v1/videos').set('Authorization', `Bearer ${key}`).type('form').send({ webViewLink: link });
    expect(urlenc.status).toBe(200); expect(urlenc.body.duplicate).toBe(true);
    expect(mediaCalls()).toHaveLength(1);
  });

  it('routes by the real file type: videos, images and other files', async () => {
    const png = craftPng(300, 200, 6), pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(500)]);
    files.set('IMG0000000000001', driveFile({ id: 'IMG0000000000001', name: 'photo.png', mimeType: 'image/png' }, png));
    files.set('PDF0000000000001', driveFile({ id: 'PDF0000000000001', name: 'brief.pdf', mimeType: 'application/pdf' }, pdf));
    files.set(ID, driveFile({}, vid));
    const i = await imp({ webViewLink: 'https://drive.google.com/file/d/IMG0000000000001/view' });
    expect(i.body.item).toMatchObject({ mediaType: 'image', width: 300, height: 200, hasAlpha: true, mimeType: 'image/png' }); expect(i.body.publicUrl).toMatch(/\/images\/[0-9a-f-]+\.png$/);
    const p = await imp({ webViewLink: 'https://drive.google.com/file/d/PDF0000000000001/view' });
    expect(p.body.item).toMatchObject({ mediaType: 'file', category: 'document', mimeType: 'application/pdf' }); expect(p.body.publicUrl).toMatch(/\/files\//);
    const asFile = await imp({ webViewLink: link }, 'files');
    expect(asFile.body.item.mediaType).toBe('file'); // the /files endpoint stores a generic file
    const forced = await imp({ webViewLink: link, library: 'video' }, 'images');
    expect(forced.status).toBe(201); expect(forced.body.item.mediaType).toBe('video');
    expect((await imp({ webViewLink: link, library: 'spaceship' })).status).toBe(400);
  });

  it('exports Google Docs and keeps the original file name', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(400)]);
    files.set('DOC0000000000001', { meta: { id: 'DOC0000000000001', name: 'Quarterly notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-02-02T00:00:00Z' }, body: bytes(pdf), contentType: 'application/pdf' });
    const r = await imp({ webViewLink: 'https://docs.google.com/document/d/DOC0000000000001/edit' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.item).toMatchObject({ mediaType: 'file', originalName: 'Quarterly notes.pdf', extension: 'pdf', mimeType: 'application/pdf' });
    expect(calls.find((c) => c.url.includes('/export'))!.url).toContain('mimeType=application%2Fpdf');
  });

  it('rejects bad input without calling Google', async () => {
    const before = reachedDrive().length;
    for (const [body, code] of [[{ webViewLink: 'https://evil.com/file/d/' + ID + '/view' }, 'invalid_drive_url'], [{ webViewLink: 'javascript:alert(1)' }, 'invalid_drive_url'], [{ webViewLink: `https://drive.google.com/drive/folders/${ID}` }, 'drive_folder_not_supported'], [{ driveFileId: 'short' }, 'invalid_drive_url'], [{ webViewLink: `https://docs.google.com/forms/d/${ID}/edit` }, 'drive_unsupported_type']] as [object, string][]) {
      const r = await imp(body); expect(r.status, JSON.stringify(body)).toBe(400); expect(r.body.error.code).toBe(code);
    }
    expect(reachedDrive().length).toBe(before); expect(videoRows()).toBe(0);
  });

  it('keeps the old behaviour for non-Drive JSON and requires a valid API key', async () => {
    expect((await imp({ hello: 'world' })).status).toBe(415);
    expect((await imp('not json {')).status).toBe(400);
    expect((await imp({ webViewLink: link }, 'videos', null)).status).toBe(401);
    expect((await imp({ webViewLink: link }, 'videos', 'lvh_bad_key')).status).toBe(401);
    const k = await createKey(admin, 'to-revoke');
    await admin.agent.post(`/api/admin/api-keys/${k.id}/revoke`).set('X-CSRF-Token', admin.csrf).send({});
    expect((await imp({ webViewLink: link }, 'videos', k.key)).body.error.code).toBe('revoked_api_key');
    expect(reachedDrive().length).toBe(0);
  });

  it('keeps ordinary binary uploads working, and a real file wins over a stray webViewLink field', async () => {
    const res = await request(env.built.app).post('/api/v1/videos').set('Authorization', `Bearer ${key}`).field('webViewLink', link).attach('data', craftMp4({ seconds: 3, width: 320, height: 180 }), { filename: 'direct.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(201); expect(res.body.item.originalName).toBe('direct.mp4'); expect(res.body.source).toBeUndefined();
    expect(reachedDrive()).toHaveLength(0);
  });

  it('detects duplicates by Drive file ID, re-imports changed files, and coalesces concurrent requests', async () => {
    files.set(ID, driveFile({}, vid));
    const [a, b, c] = await Promise.all([imp({ webViewLink: link }), imp({ webViewLink: link }), imp({ webViewLink: link })]);
    expect(new Set([a.body.item.id, b.body.item.id, c.body.item.id]).size).toBe(1);
    expect([a, b, c].map((r) => r.body.duplicate).sort()).toEqual([false, true, true]);
    expect(mediaCalls()).toHaveLength(1); expect(videoRows()).toBe(1);
    const again = await imp({ webViewLink: link });
    expect(again.status).toBe(200); expect(again.body.duplicate).toBe(true); expect(mediaCalls()).toHaveLength(1);
    const v2 = craftMp4({ seconds: 20, width: 640, height: 360 });
    files.set(ID, driveFile({}, v2)); // same Drive ID, new content
    const changed = await imp({ webViewLink: link });
    expect(changed.status).toBe(201); expect(changed.body.item.id).not.toBe(a.body.item.id); expect(videoRows()).toBe(2);
    await admin.agent.post('/api/admin/videos/trash').set('X-CSRF-Token', admin.csrf).send({ ids: [changed.body.item.id] });
    const afterTrash = await imp({ webViewLink: link });
    expect(afterTrash.status).toBe(201); // the new version was trashed, so the unchanged-file shortcut no longer applies: a fresh, active copy is created
    expect(afterTrash.body.item.id).not.toBe(changed.body.item.id); expect(afterTrash.body.item.status).toBe('active');
  });

  it('maps Google errors to clear API errors and imports nothing', async () => {
    const cases: [Partial<MockFile> & { reasonTxt?: string }, number, string][] = [
      [{ metaStatus: 404 }, 404, 'drive_file_not_found'], [{ metaStatus: 403, reason: 'insufficientFilePermissions' }, 403, 'drive_access_denied'], [{ metaStatus: 403, reason: 'cannotDownloadFile' }, 403, 'drive_download_restricted'],
      [{ metaStatus: 403, reason: 'userRateLimitExceeded' }, 429, 'drive_quota_exceeded'], [{ metaStatus: 429 }, 429, 'drive_quota_exceeded'], [{ mediaStatus: 403, reason: 'downloadRestricted' }, 403, 'drive_download_restricted'], [{ mediaStatus: 404 }, 404, 'drive_file_not_found'],
    ];
    for (const [extra, status, code] of cases) {
      files.set(ID, driveFile({}, vid, extra));
      const r = await imp({ webViewLink: link });
      expect(r.status, code + JSON.stringify(extra)).toBe(status); expect(r.body.error.code).toBe(code); expect(JSON.stringify(r.body)).not.toMatch(/AT-|RT-|Bearer/);
    }
    expect((await imp({ webViewLink: link.replace(ID, 'MISSING0000000000') })).body.error.code).toBe('drive_file_not_found');
    expect(videoRows()).toBe(0); expect(uploadsCount()).toBe(0); expect(tempFiles()).toEqual([]);
    files.set(ID, driveFile({ trashed: true }, vid)); expect((await imp({ webViewLink: link })).status).toBe(404);
    files.set(ID, driveFile({ capabilities: { canDownload: false } }, vid)); expect((await imp({ webViewLink: link })).body.error.code).toBe('drive_download_restricted');
    files.set(ID, driveFile({ mimeType: 'application/vnd.google-apps.form' }, vid)); expect((await imp({ webViewLink: link })).body.error.code).toBe('drive_unsupported_type');
    files.set(ID, driveFile({ mimeType: 'application/vnd.google-apps.folder' }, vid)); expect((await imp({ webViewLink: link })).body.error.code).toBe('drive_folder_not_supported');
  });

  it('refreshes expired tokens, and asks for reauthorisation when Google revokes access', async () => {
    files.set(ID, driveFile({}, vid));
    env.built.ctx.db.prepare("UPDATE kv SET value = ? WHERE key = 'gdrive.access_expires'").run(new Date(Date.now() - 1000).toISOString());
    expect((await imp({ webViewLink: link })).status).toBe(201);
    expect(calls.filter((c) => c.url.includes('/token') && c.body.includes('refresh_token'))).toHaveLength(1);
    files.set('SECOND0000000001', driveFile({ id: 'SECOND0000000001' }, craftMp4({ seconds: 4, width: 320, height: 240 })));
    env.built.ctx.db.prepare("UPDATE kv SET value = ? WHERE key = 'gdrive.access_expires'").run(new Date(Date.now() - 1000).toISOString());
    refreshMode = 'invalid_grant';
    const r = await imp({ webViewLink: 'https://drive.google.com/file/d/SECOND0000000001/view' });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('drive_reauthorization_required');
    expect((await admin.agent.get('/api/admin/drive/status')).body.status).toBe('reauthorization_required');
    const diag = await admin.agent.get('/api/admin/diagnostics');
    expect(diag.body.drive.status).toBe('reauthorization_required'); expect(diag.body.messages.some((m: { text: string }) => /Google Drive access has expired/.test(m.text))).toBe(true);
    const fast = calls.length; expect((await imp({ webViewLink: link.replace(ID, 'SECOND0000000001') })).status).toBe(409); expect(calls.length).toBe(fast); // fails fast, no Google calls
    refreshMode = 'ok'; await connectDrive();
    expect((await imp({ webViewLink: 'https://drive.google.com/file/d/SECOND0000000001/view' })).status).toBe(201);
  });

  it('handles a Drive-side 401 by refreshing once', async () => {
    files.set(ID, driveFile({}, vid));
    let first = true;
    const orig = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes(`/files/${ID}?fields`) && first) { first = false; return json({ error: { code: 401 } }, 401); }
      return orig(input as never, init);
    });
    expect((await imp({ webViewLink: link })).status).toBe(201);
    expect(calls.filter((c) => c.url.includes('/token') && c.body.includes('refresh_token'))).toHaveLength(1);
  });

  it('rejects oversized files before downloading, and enforces the limit while streaming', async () => {
    await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ maxUploadBytes: 1024 * 1024 });
    try {
      files.set(ID, driveFile({ size: String(5 * 1024 * 1024) }, vid));
      const r = await imp({ webViewLink: link });
      expect(r.status).toBe(413); expect(r.body.error.code).toBe('file_too_large'); expect(mediaCalls()).toHaveLength(0);
      // size unknown in metadata (e.g. an export): the limit is still enforced while streaming
      const big = [Buffer.concat([vid.subarray(0, 100), crypto.randomBytes(900_000)]), crypto.randomBytes(900_000)];
      files.set(ID, { meta: { id: ID, name: 'x.mp4', mimeType: 'video/mp4', modifiedTime: 'm1' }, body: stream(big), contentType: 'video/mp4' });
      const s = await imp({ webViewLink: link });
      expect(s.status).toBe(413); expect(tempFiles()).toEqual([]); expect(uploadsCount()).toBe(0); expect(videoRows()).toBe(0);
    } finally { await admin.agent.put('/api/admin/settings').set('X-CSRF-Token', admin.csrf).send({ maxUploadBytes: 1024 ** 3 }); }
  });

  it('cleans up after interrupted, truncated, HTML and invalid downloads', async () => {
    const chunks = [vid.subarray(0, 100_000), vid.subarray(100_000, 200_000), vid.subarray(200_000)];
    files.set(ID, driveFile({}, vid, { body: stream(chunks, { errorAfter: 1 }) }));
    const interrupted = await imp({ webViewLink: link });
    expect(interrupted.status).toBe(502); expect(interrupted.body.error.code).toBe('drive_download_failed');
    files.set(ID, driveFile({}, vid, { body: stream(chunks.slice(0, 2)) }));
    const truncated = await imp({ webViewLink: link });
    expect(truncated.status).toBe(502); expect(truncated.body.error.code).toBe('drive_download_incomplete');
    files.set(ID, driveFile({}, vid, { body: bytes(Buffer.from('<html><body>Sign in to continue</body></html>')), contentType: 'text/html; charset=utf-8' }));
    const html = await imp({ webViewLink: link });
    expect(html.status).toBe(502); expect(html.body.error.code).toBe('drive_unexpected_response');
    const fakeVideo = Buffer.from('this is plain text pretending to be a video\n'.repeat(60));
    files.set(ID, driveFile({}, fakeVideo));
    const fake = await imp({ webViewLink: link });
    expect(fake.status).toBe(415); expect(fake.body.error.code).toBe('unsupported_media_type');
    files.set(ID, driveFile({ size: '0', md5Checksum: undefined }, undefined, { body: bytes(Buffer.alloc(0)) }));
    expect((await imp({ webViewLink: link })).body.error.code).toBe('empty_file');
    expect(tempFiles()).toEqual([]); expect(uploadsCount()).toBe(0); expect(videoRows()).toBe(0);
    const logged = env.built.ctx.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE type = 'drive_import_failed'").get() as { c: number };
    expect(logged.c).toBeGreaterThanOrEqual(5);
  });

  it('streams large files to disk while the download is still running (no full-memory buffering)', async () => {
    const MB = 1024 * 1024, total = 40;
    const chunk = crypto.randomBytes(MB);
    const head = craftMp4({ seconds: 5, width: 640, height: 360, padTo: MB });
    const chunks = [head, ...Array.from({ length: total - 1 }, () => chunk)];
    const all = crypto.createHash('sha256'); chunks.forEach((c) => all.update(c));
    let release!: () => void; const wait = new Promise<void>((r) => { release = r; });
    files.set(ID, driveFile({ size: String(head.length + (total - 1) * MB), md5Checksum: undefined }, undefined, { body: stream(chunks, { gate: { chunk: 25, wait } }) }));
    const pending = imp({ webViewLink: link }).then((r) => r);
    let partSize = 0;
    for (let i = 0; i < 200 && partSize < 20 * MB; i++) {
      const parts = tempFiles().filter((f) => f.endsWith('.part'));
      partSize = parts.length ? fs.statSync(path.join(env.built.ctx.config.dirs.temp, parts[0])).size : 0;
      if (partSize < 20 * MB) await new Promise((r) => setTimeout(r, 25));
    }
    expect(partSize).toBeGreaterThanOrEqual(20 * MB); // bytes are on disk while the transfer is only 60% done
    expect(videoRows()).toBe(0);                      // and nothing is visible in the library yet
    const running = [...env.built.ctx.drive.jobs.values()].find((j) => j.state === 'running');
    expect(running?.bytes).toBeGreaterThan(20 * MB);
    release();
    const done = await pending;
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.item.sha256).toBe(all.digest('hex')); expect(done.body.item.size).toBe(head.length + (total - 1) * MB);
    expect(tempFiles()).toEqual([]);
  });

  it('supports async imports with a pollable status endpoint (for the Cloudflare 100 s limit)', async () => {
    files.set(ID, driveFile({}, vid));
    const r = await imp({ webViewLink: link, async: true });
    expect(r.status).toBe(202); expect(r.body).toMatchObject({ success: true, async: true, jobId: expect.any(String) }); expect(r.body.statusUrl).toBe(`http://localhost:3000/api/v1/imports/${r.body.jobId}`);
    let st: request.Response | null = null;
    for (let i = 0; i < 100; i++) { st = await request(env.built.app).get(`/api/v1/imports/${r.body.jobId}`).set('Authorization', `Bearer ${key}`); if (st.body.job.state === 'done' || st.body.job.state === 'failed') break; await new Promise((x) => setTimeout(x, 30)); }
    expect(st!.body.job.state).toBe('done'); expect(st!.body.publicUrl).toMatch(/\/videos\/.+\.mp4$/); expect(st!.body.item.durationSeconds).toBe(95);
    expect((await request(env.built.app).get(`/api/v1/imports/${r.body.jobId}`)).status).toBe(401);
    expect((await request(env.built.app).get('/api/v1/imports/nonexistent').set('Authorization', `Bearer ${key}`)).status).toBe(404);
    files.set(ID, driveFile({}, vid, { metaStatus: 404 }));
    const bad = await imp({ webViewLink: link.replace(ID, 'GONE00000000000'), async: true });
    let st2; for (let i = 0; i < 100; i++) { st2 = await request(env.built.app).get(`/api/v1/imports/${bad.body.jobId}`).set('Authorization', `Bearer ${key}`); if (st2.body.job.state !== 'running' && st2.body.job.state !== 'queued') break; await new Promise((x) => setTimeout(x, 30)); }
    expect(st2!.body.job).toMatchObject({ state: 'failed', error: { code: 'drive_file_not_found' } });
  });

  it('imports from the dashboard with visible progress, and logs the whole flow without secrets', async () => {
    files.set(ID, driveFile({}, vid));
    expect((await admin.agent.post('/api/admin/drive/import').send({ source: link })).status).toBe(403);
    const r = await admin.agent.post('/api/admin/drive/import').set('X-CSRF-Token', admin.csrf).send({ source: link, library: 'auto' });
    expect(r.status).toBe(202);
    let job: Record<string, any> | undefined;
    for (let i = 0; i < 100; i++) { job = (await admin.agent.get('/api/admin/drive/imports')).body.items.find((j: { id: string }) => j.id === r.body.jobId); if (job && ['done', 'failed'].includes(job.state)) break; await new Promise((x) => setTimeout(x, 30)); }
    expect(job).toMatchObject({ state: 'done', origin: 'dashboard', name: 'clip.mp4', library: 'video', bytes: vid.length, total: vid.length, duplicate: false });
    expect(job!.publicUrl).toMatch(/\/videos\//);
    expect((await admin.agent.post('/api/admin/drive/import').set('X-CSRF-Token', admin.csrf).send({ source: 'nonsense' })).status).toBe(400);
    const logs = await admin.agent.get('/api/admin/logs?pageSize=200');
    const types = new Set(logs.body.items.map((e: { type: string }) => e.type));
    for (const t of ['drive_connected', 'drive_import_requested', 'drive_download_started', 'drive_download_completed', 'drive_import_completed', 'video_uploaded']) expect(types, t).toContain(t);
    expect(JSON.stringify(logs.body)).not.toMatch(/RT-SECRET|AT-\d|GOCSPX|good-code|Bearer /);
  });

  it('shows Drive status in diagnostics', async () => {
    await admin.agent.post('/api/admin/drive/test').set('X-CSRF-Token', admin.csrf).send({});
    const d = await admin.agent.get('/api/admin/diagnostics');
    expect(d.body.drive).toMatchObject({ status: 'connected', account: 'owner@example.com', lastCheck: { ok: true } });
  });

  it('never fetches arbitrary URLs: every outgoing request goes to a Google host', async () => {
    files.set(ID, driveFile({}, vid));
    await imp({ webViewLink: link, url: 'http://169.254.169.254/latest/meta-data/' });
    await imp({ driveUrl: 'https://drive.google.com.evil.example/file/d/' + ID + '/view' });
    expect(calls.every((c) => /^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com|www\.googleapis\.com)\//.test(c.url))).toBe(true);
  });
});
