import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5200, strictPort: true },
  preview: { host: '127.0.0.1', port: 5200 },
  // latkit loads its wasm from beside its own module, which prebundling would move.
  optimizeDeps: { exclude: ['latkit'] },
  build: { target: 'es2022' },
});
