import fs from 'node:fs';
import path from 'node:path';

export interface RateLimits {
  loginMax: number; loginWindowMs: number;
  setupMax: number;
  uploadMax: number; uploadWindowMs: number;
  adminMax: number;
}

export interface AppConfig {
  projectRoot: string;
  host: string;
  port: number;
  storageRoot: string;
  dataDir: string;
  dirs: { uploads: string; trash: string; temp: string; logs: string };
  dbPath: string;
  setupTokenPath: string;
  webDist: string;
  trustProxy: boolean | number | string;
  cookieSecure: 'auto' | boolean;
  defaultPublicBaseUrl: string;
  devMode: boolean;
  version: string;
  rateLimits: RateLimits;
  enableScheduler: boolean;
  /** FFprobe executable (name on PATH or absolute path). Optional: built-in parsers are used when it is missing. */
  ffprobePath: string;
  /** Print the first-run setup token to the terminal when it is generated. */
  printSetupToken: boolean;
}

/** Minimal .env loader (no dependency). Real environment variables always win. */
export function loadDotEnv(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    let val = m[2];
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (env[key] === undefined) env[key] = val;
  }
}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') throw new Error('TRUST_PROXY=true is unsafe (it trusts any forwarded address). Use a hop count such as 1, or "loopback".');
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function loadConfig(overrides: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const projectRoot = overrides.projectRoot ?? process.cwd();
  const resolve = (p: string) => path.resolve(projectRoot, p);
  const port = Number(env.PORT ?? 3000);
  const storageRoot = resolve(env.STORAGE_ROOT ?? './storage');
  const dataDir = resolve(env.DATA_DIR ?? './data');
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version ?? version; } catch { /* ignore */ }
  const cookieSecureEnv = (env.COOKIE_SECURE ?? 'auto').toLowerCase();
  const base: AppConfig = {
    projectRoot,
    host: env.HOST ?? '127.0.0.1',
    port,
    storageRoot,
    dataDir,
    dirs: {
      uploads: path.join(storageRoot, 'uploads'),
      trash: path.join(storageRoot, 'trash'),
      temp: path.join(storageRoot, 'temp'),
      logs: path.join(storageRoot, 'logs'),
    },
    dbPath: path.join(dataDir, 'app.db'),
    setupTokenPath: path.join(dataDir, 'setup-token.txt'),
    webDist: path.join(projectRoot, 'dist', 'web'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cookieSecure: cookieSecureEnv === 'auto' ? 'auto' : cookieSecureEnv === 'true',
    defaultPublicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    devMode: env.NODE_ENV !== 'production',
    version,
    rateLimits: { loginMax: 10, loginWindowMs: 15 * 60_000, setupMax: 10, uploadMax: 600, uploadWindowMs: 10 * 60_000, adminMax: 3000 },
    enableScheduler: true,
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    printSetupToken: true,
  };
  return { ...base, ...overrides, dirs: overrides.dirs ?? base.dirs, rateLimits: { ...base.rateLimits, ...(overrides.rateLimits ?? {}) } };
}
