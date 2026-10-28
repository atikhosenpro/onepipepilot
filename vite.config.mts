import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  // Directs Vite to the correct web root directory
  root: path.resolve(import.meta.dirname, 'web'),
  
  plugins: [react()],
  
  build: { 
    outDir: path.resolve(import.meta.dirname, 'dist/web'), 
    emptyOutDir: true, 
    sourcemap: false 
  },
  
  server: {
    // 1. Fixes the host block error (Added new domain and localtunnel domain)
    allowedHosts: [
      'cloud.atikhosen.com',
      'https://onepipepilot.wasmer.app',
      'onepipepilot.vercel.app'
    ],
    
    // 2. Preserves your security restrictions for files
    fs: { 
      strict: true, 
      allow: [
        path.resolve(import.meta.dirname, 'web'), 
        path.resolve(import.meta.dirname, 'node_modules')
      ], 
      deny: [
        '**/data/**', 
        '**/storage/**', 
        '**/.env*', 
        '**/*.db', 
        '**/*.pem'
      ] 
    } 
  },
});
