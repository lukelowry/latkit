import { defineConfig } from 'vite';
export default defineConfig({
  build: { rollupOptions: { input: { video: 'index.html', check: 'check.html' } } },
});
