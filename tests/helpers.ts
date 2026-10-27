import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { buildApp, type BuiltApp } from '../server/app';
import type { AppConfig } from '../server/config';

export interface TestEnv { root: string; built: BuiltApp; config: Partial<AppConfig>; cleanup(): void }

export function makeConfig(root: string, extra: Partial<AppConfig> = {}): Partial<AppConfig> {
  const storageRoot = path.join(root, 'storage');
  const dataDir = path.join(root, 'data');
  return {
    projectRoot: root, storageRoot, dataDir,
    dirs: { uploads: path.join(storageRoot, 'uploads'), trash: path.join(storageRoot, 'trash'), temp: path.join(storageRoot, 'temp'), logs: path.join(storageRoot, 'logs') },
    dbPath: path.join(dataDir, 'app.db'), setupTokenPath: path.join(dataDir, 'setup-token.txt'), webDist: path.join(root, 'dist', 'web'),
    devMode: false, enableScheduler: false, printSetupToken: false, host: '127.0.0.1', port: 0, trustProxy: false, cookieSecure: false,
    defaultPublicBaseUrl: 'http://localhost:3000', version: 'test',
    rateLimits: { loginMax: 1000, loginWindowMs: 60_000, setupMax: 1000, uploadMax: 10_000, uploadWindowMs: 60_000, adminMax: 100_000 },
    ...extra,
  };
}

export function createEnv(extra: Partial<AppConfig> = {}, existingRoot?: string): TestEnv {
  const root = existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lvh-test-'));
  const config = makeConfig(root, extra);
  const built = buildApp({ config, silent: true });
  return { root, built, config, cleanup() { built.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

export const PASSWORD = 'Correct-Horse-9-Battery';
export const USER = 'atik_admin';

/** Completes first-run setup and returns an authenticated agent plus its CSRF token. */
export async function setupAdmin(env: TestEnv) {
  const token = fs.readFileSync(env.built.ctx.config.setupTokenPath, 'utf8').trim();
  const agent = request.agent(env.built.app);
  const res = await agent.post('/api/admin/setup').send({ token, username: USER, password: PASSWORD });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken as string, token };
}

export async function login(env: TestEnv) {
  const agent = request.agent(env.built.app);
  const res = await agent.post('/api/admin/login').send({ username: USER, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { agent, csrf: res.body.csrfToken as string };
}

export async function createKey(a: { agent: ReturnType<typeof request.agent>; csrf: string }, label = 'test') {
  const res = await a.agent.post('/api/admin/api-keys').set('X-CSRF-Token', a.csrf).send({ label });
  return { key: res.body.key as string, id: res.body.item.id as string };
}

/** A minimal but structurally valid MP4 (ftyp box + mdat box of random bytes). */
export function makeMp4(totalSize = 4096, brand = 'isom'): Buffer {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2')]);
  const payload = crypto.randomBytes(Math.max(totalSize - ftyp.length - 8, 1));
  const mdatHeader = Buffer.alloc(8); mdatHeader.writeUInt32BE(payload.length + 8, 0); mdatHeader.write('mdat', 4, 'latin1');
  return Buffer.concat([ftyp, mdatHeader, payload]);
}

export function makeWebm(totalSize = 2048): Buffer {
  const head = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.from([0x42, 0x87, 0x81, 0x04])]);
  return Buffer.concat([head, crypto.randomBytes(Math.max(totalSize - head.length, 1))]);
}

export const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
