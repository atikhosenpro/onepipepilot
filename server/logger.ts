import fs from 'node:fs';
import path from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const SECRET_KEY = /pass|secret|token|cookie|authorization|apikey|api_key|hash/i;
export function redact(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) out[k] = SECRET_KEY.test(k) && !/^apiKeyId$/i.test(k) ? '[redacted]' : v;
  return out;
}

export function createLogger(logDir: string, getLevel: () => Level, opts: { silent?: boolean } = {}): Logger {
  const file = path.join(logDir, 'app.log');
  const write = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (order[level] < order[getLevel()]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...redact(meta) });
    if (!opts.silent) (level === 'error' ? console.error : console.log)(`[${level}] ${msg}`);
    try {
      fs.mkdirSync(logDir, { recursive: true });
      try { if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
      fs.appendFileSync(file, line + '\n');
    } catch { /* logging must never crash the app */ }
  };
  return {
    debug: (m, x) => write('debug', m, x), info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x), error: (m, x) => write('error', m, x),
  };
}
