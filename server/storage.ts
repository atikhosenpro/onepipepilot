import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Ctx } from './context';

export async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dst)]);
    if (a.size !== b.size) { await fs.promises.unlink(dst).catch(() => undefined); throw new Error('Copy verification failed', { cause: e }); }
    await fs.promises.unlink(src);
  }
}

export async function dirStats(dir: string): Promise<{ exists: boolean; fileCount: number; totalBytes: number; error?: string }> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    let fileCount = 0, totalBytes = 0;
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.probe-')) continue;
      try { totalBytes += (await fs.promises.stat(path.join(dir, e.name))).size; fileCount++; } catch { /* vanished */ }
    }
    return { exists: true, fileCount, totalBytes };
  } catch (e) {
    return { exists: false, fileCount: 0, totalBytes: 0, error: (e as NodeJS.ErrnoException).code ?? 'ERROR' };
  }
}

export async function checkWritable(dir: string): Promise<{ writable: boolean; error?: string }> {
  const probe = path.join(dir, `.probe-${randomUUID()}`);
  try {
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.unlink(probe);
    return { writable: true };
  } catch (e) {
    return { writable: false, error: (e as NodeJS.ErrnoException).code ?? 'ERROR' };
  }
}

export async function diskSpace(dir: string): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}

export const uploadPath = (ctx: Ctx, storageName: string) => path.join(ctx.config.dirs.uploads, path.basename(storageName));
export const trashPath = (ctx: Ctx, storageName: string) => path.join(ctx.config.dirs.trash, path.basename(storageName));

/** Remove stale temp files that are not part of an in-flight upload. */
export async function cleanTemp(ctx: Ctx, olderThanMs: number): Promise<{ removed: number; bytes: number; errors: number }> {
  const res = { removed: 0, bytes: 0, errors: 0 };
  let names: string[];
  try { names = await fs.promises.readdir(ctx.config.dirs.temp); } catch { return res; }
  const cutoff = Date.now() - olderThanMs;
  for (const name of names) {
    const full = path.join(ctx.config.dirs.temp, name);
    if (ctx.activeTemps.has(full)) continue;
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      await fs.promises.unlink(full);
      res.removed++; res.bytes += st.size;
    } catch { res.errors++; }
  }
  return res;
}
