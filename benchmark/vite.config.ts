import { defineConfig } from 'vite';
import path from 'node:path';
import { tiles } from './tiles.ts';

export default defineConfig({
  plugins: [tiles()],
  // A preserved package can be measured with the same page, data, and driver.
  resolve: process.env.LATKIT_PACKAGE
    ? { alias: { latkit: path.resolve(process.env.LATKIT_PACKAGE, 'dist/index.js') } }
    : undefined,
  // latkit loads its wasm from beside its own module, which prebundling would move.
  optimizeDeps: { exclude: ['latkit'] },
  build: { target: 'es2022' },
});
