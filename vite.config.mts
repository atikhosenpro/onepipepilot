import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The web root is ./web so the Vite dev server can never serve ./data or './storage'.
export default defineConfig(() => {
  const allowedHosts = ['minolta-hopkins-canvas-brad.trycloudflare.com', 'cloud.atikhosen.com', 'local.atikhosen.com', 'could.atikhosen.com', 'n8n-live.atikhosen.com'];
  if (process.env.VITE_ALLOWED_HOSTS) {
    const extra = process.env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
    for (const h of extra) {
      if (!allowedHosts.includes(h)) allowedHosts.push(h);
    }
  }

  return {
    root: path.resolve(import.meta.dirname, 'web'),
    plugins: [react()],
    build: { outDir: path.resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true, sourcemap: false },
    server: {
      host: true,
      port: 3000,
      strictPort: false,
      allowedHosts,
      fs: {
        strict: true,
        allow: [path.resolve(import.meta.dirname, 'web'), path.resolve(import.meta.dirname, 'node_modules')],
        deny: ['**/data/**', '**/storage/**', '**/.env*', '**/*.db', '**/*.pem']
      }
    },
  };
});
