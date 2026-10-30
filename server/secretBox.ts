/** AES-256-GCM encryption for credentials at rest. The key lives OUTSIDE the database (env var or a separate 0600 key file). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map<string, Buffer>();

export function loadKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (env.DRIVE_ENCRYPTION_KEY) {
    if (env.DRIVE_ENCRYPTION_KEY.length < 16) throw new Error('DRIVE_ENCRYPTION_KEY must be at least 16 characters.');
    return crypto.createHash('sha256').update(env.DRIVE_ENCRYPTION_KEY).digest();
  }
  const file = path.join(dataDir, 'drive-encryption.key');
  const hit = cache.get(file);
  if (hit) return hit;
  let key: Buffer;
  if (fs.existsSync(file)) key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  else { key = crypto.randomBytes(32); fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 }); }
  if (key.length !== 32) throw new Error('drive-encryption.key is corrupt (expected 32 bytes).');
  cache.set(file, key);
  return key;
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function unseal(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable encrypted value.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
