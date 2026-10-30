// `npm run package:zip`: builds release/onepipepilot.zip from source (cross-platform, no external zip tool).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'release', 'onepipepilot.zip');

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'data', 'storage', 'release', '.git', '.test-tmp', '.vite', 'coverage']);
const EXCLUDE_FILE = [/^\.env$/, /^\.env\.(?!example$).+/, /\.log$/i, /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i, /^setup-token\.txt$/, /\.zip$/i, /\.tsbuildinfo$/, /^\.DS_Store$/, /^Thumbs\.db$/i];
const FORBIDDEN_ENTRY = [/(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)\.env$/, /\.(db|db-wal|db-shm|sqlite3?)$/i, /(^|\/)setup-token\.txt$/, /(^|\/)(data|storage|dist)\//, /\.log$/i];

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(full); }
    else if (e.isFile() && !EXCLUDE_FILE.some((re) => re.test(e.name))) files.push(full);
  }
})(root);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
if (fs.existsSync(outFile)) fs.rmSync(outFile);

const names = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
const bad = names.filter((n) => FORBIDDEN_ENTRY.some((re) => re.test(n)));
if (bad.length) { console.error('Refusing to package forbidden files:', bad); process.exit(1); }
for (const need of ['package.json', 'package-lock.json', 'README.md', 'API.md', 'CLAUDE.md', 'AGENTS.md', '.env.example', '.npmrc']) {
  if (!names.includes(need)) { console.error(`Missing required file: ${need}`); process.exit(1); }
}

const output = fs.createWriteStream(outFile);
const archive = new ZipArchive({ zlib: { level: 9 } });
const done = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
archive.pipe(output);
for (const n of names) archive.file(path.join(root, ...n.split('/')), { name: n, date: new Date('2026-01-01T00:00:00Z') });
await archive.finalize();
await done;
console.log(`Created ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB, ${names.length} files)`);
