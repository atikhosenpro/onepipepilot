import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The web root is ./web so the Vite dev server can never serve ./data or ./storage.
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true, sourcemap: false },
  server: { fs: { strict: true, allow: [path.resolve(import.meta.dirname, 'web'), path.resolve(import.meta.dirname, 'node_modules')], deny: ['**/data/**', '**/storage/**', '**/.env*', '**/*.db', '**/*.pem'] } },
});
