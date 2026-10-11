import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { input: { signals: 'index.html', bunny: 'bunny.html' } } },
  server: { host: '127.0.0.1', port: 5198, open: false },
  preview: { host: '127.0.0.1', port: 5198 },
});
