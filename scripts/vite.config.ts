import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, '../src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, '../src/shared'),
      '@renderer': resolve(import.meta.dirname, '../src/renderer'),
      '@electron': resolve(import.meta.dirname, '../src/electron'),
      '@backend': resolve(import.meta.dirname, '../src/backend'),
      '@scripts': resolve(import.meta.dirname, '..'),
    },
  },
  plugins: [react(), tailwind(), {
    name: 'moki-development-html',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'none'", "connect-src 'self' ws://127.0.0.1:5173")
        .replace('<title>Moki</title>', '<title>Moki Dev</title>')
        .replace('./app.css', './styles/tailwind.css')
        .replace('./app.js', './entry.tsx'),
    },
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, cors: false,
    fs: { allow: [resolve(import.meta.dirname, '../src'), resolve(import.meta.dirname, '../node_modules')] },
  },
  build: { outDir: resolve(import.meta.dirname, '../dist/dev/renderer-check'), sourcemap: true },
});
