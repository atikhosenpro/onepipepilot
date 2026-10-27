// `npm run start`: production mode (serves the built dashboard). Builds first if needed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDeps } from './ensure-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = existsSync(path.join(root, 'dist/server/index.js')) && existsSync(path.join(root, 'dist/web/index.html'));
if (!built) {
  ensureDeps();
  console.log('[start] No production build found - running "npm run build" first...\n');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error('[start] Build failed.'); process.exit(r.status ?? 1); }
}
const child = spawn(process.execPath, ['dist/server/index.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
