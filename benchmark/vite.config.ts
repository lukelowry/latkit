import { defineConfig } from 'vite';
import { tiles } from './tiles.ts';

export default defineConfig({
  plugins: [tiles()],
  // latkit loads its wasm from beside its own module, which prebundling would move.
  optimizeDeps: { exclude: ['latkit'] },
  build: { target: 'es2022' },
});
