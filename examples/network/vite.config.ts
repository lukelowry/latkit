import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { input: { earth: 'index.html', blackout: 'blackout.html' } } },
  server: { host: '127.0.0.1', port: 5188, open: false },
  preview: { host: '127.0.0.1', port: 5188 },
});
