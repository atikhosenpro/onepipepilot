// `npm run dev`: bootstrap dependencies, then run API + dashboard (Vite in middleware mode) on ONE port.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDeps } from './ensure-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
ensureDeps();
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const child = spawn(process.execPath, [tsxCli, 'watch', '--clear-screen=false', 'server/index.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' },
});
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
