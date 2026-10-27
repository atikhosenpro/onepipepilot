// Makes sure npm dependencies are installed (using the lockfile) before dev/build/test/lint.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['express', 'better-sqlite3', 'busboy', 'helmet', 'zod', 'tsx', 'vite', 'typescript', 'vitest', 'react', 'tailwindcss'];

export function checkNode() {
  const [maj] = process.versions.node.split('.').map(Number);
  if (maj < 22) {
    console.error(`\nNode.js ${process.versions.node} is too old. Please install Node.js 22 or newer (LTS) from https://nodejs.org\n`);
    process.exit(1);
  }
}

export function ensureDeps() {
  checkNode();
  const missing = REQUIRED.filter((m) => !existsSync(path.join(root, 'node_modules', m, 'package.json')));
  if (missing.length === 0) return;
  const useCi = existsSync(path.join(root, 'package-lock.json'));
  console.log(`\n[setup] Dependencies are missing (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', ...' : ''}).`);
  console.log(`[setup] Installing with "npm ${useCi ? 'ci' : 'install'}" - this can take a minute, please wait...\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, [useCi ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error('\n[setup] FAILED to install dependencies. Check your internet connection and that Node.js/npm are installed correctly, then run "npm install" manually and retry.\n');
    process.exit(r.status ?? 1);
  }
  console.log('\n[setup] Dependencies installed.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureDeps();
