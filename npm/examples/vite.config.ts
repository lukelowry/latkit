import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5200, strictPort: true },
  preview: { host: '127.0.0.1', port: 5200 },
  // The package loads its wasm next to itself; prebundling would move it.
  optimizeDeps: { exclude: ['latkit'] },
  build: { target: 'es2022' },
});
