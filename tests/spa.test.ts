import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, createKey, makeMp4, setupAdmin, type TestEnv } from './helpers';
import { craftPng } from './fixtures';

const HTML = '<!doctype html><html><head><title>OnePipePilot</title></head><body><div id="root"></div></body></html>';
let env: TestEnv; let key: string;

beforeAll(async () => {
  // A real production layout: the built dashboard exists, so the SPA fallback is active (this is what a hard refresh hits).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvh-spa-'));
  fs.mkdirSync(path.join(root, 'dist', 'web', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'web', 'index.html'), HTML);
  fs.writeFileSync(path.join(root, 'dist', 'web', 'assets', 'app.js'), 'console.log(1)');
  env = createEnv({}, root);
  key = (await createKey(await setupAdmin(env))).key;
});
afterAll(() => env.cleanup());

const page = (p: string, method: 'get' | 'head' = 'get') => request(env.built.app)[method](p).set('Accept', 'text/html,application/xhtml+xml');

describe('dashboard pages survive a hard refresh', () => {
  for (const p of ['/', '/videos', '/images', '/files', '/drive', '/trash', '/storage', '/api-keys', '/logs', '/settings', '/docs', '/system', '/account']) {
    it(`GET ${p} returns the dashboard`, async () => {
      const res = await page(p);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('<div id="root">');
    });
  }
  for (const p of ['/videos', '/images', '/files']) {
    it(`${p} also works with a trailing slash, with HEAD, and keeps working repeatedly`, async () => {
      expect((await page(`${p}/`)).status).toBe(200);
      expect((await page(p, 'head')).status).toBe(200);
      for (let i = 0; i < 3; i++) expect((await page(p)).text).toContain('<div id="root">');
    });
    it(`${p} does not turn into a file listing and rejects writes`, async () => {
      expect((await request(env.built.app).post(p).send({})).status).toBe(404);
      expect((await request(env.built.app).delete(p)).status).toBe(404);
    });
  }
  it('serves built assets', async () => {
    expect((await request(env.built.app).get('/assets/app.js')).status).toBe(200);
  });
});

describe('public media URLs are unaffected', () => {
  it('still serves videos, images and files, and still returns JSON for bad IDs', async () => {
    const up = (kind: string, buf: Buffer, name: string) => request(env.built.app).post(`/api/v1/${kind}`).set('Authorization', `Bearer ${key}`).attach('data', buf, name);
    const v = await up('videos', makeMp4(5000), 'a.mp4');
    const i = await up('images', craftPng(8, 8), 'a.png');
    const f = await up('files', Buffer.from('hello'), 'a.txt');
    for (const r of [v, i, f]) {
      expect(r.status).toBe(201);
      const res = await request(env.built.app).get(new URL(r.body.publicUrl).pathname);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).not.toMatch(/html/);
    }
    for (const bad of ['/videos/nonexistent', '/images/nonexistent', '/files/nonexistent', `/videos/${crypto.randomUUID()}.mp4`, `/images/${crypto.randomUUID()}.png`, '/files/a/b', '/videos/..%2f..%2fpackage.json']) {
      const res = await page(bad); // even a browser-style request must get JSON, never the dashboard
      expect(res.status, bad).toBe(404);
      expect(res.headers['content-type'], bad).toMatch(/json/);
      expect(res.body.error.code).toBe('not_found');
    }
    expect((await request(env.built.app).get(`/api/v1/images/${crypto.randomUUID()}`)).status).toBe(401);
  });
  it('does not let an image ID be fetched through another library path', async () => {
    const i = await request(env.built.app).post('/api/v1/images').set('Authorization', `Bearer ${key}`).attach('data', craftPng(8, 8), 'b.png');
    expect((await page(`/videos/${i.body.item.id}.png`)).status).toBe(404);
    expect((await page(`/files/${i.body.item.id}.png`)).status).toBe(404);
  });
  it('keeps API routes JSON', async () => {
    const res = await page('/api/nope');
    expect(res.status).toBe(404); expect(res.headers['content-type']).toMatch(/json/);
  });
});
