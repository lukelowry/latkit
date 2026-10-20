import { defineConfig } from 'vite';
import { tiles } from './tiles.ts';

export default defineConfig({
  plugins: [tiles()],
  // The package loads its wasm next to itself; prebundling would move it.
  optimizeDeps: { exclude: ['latkit'] },
  build: { target: 'es2022' },
});
