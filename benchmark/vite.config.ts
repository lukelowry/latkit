import { defineConfig } from 'vite';
import path from 'node:path';
import { tiles } from './tiles.ts';

/** The package measured: the workspace's, or a preserved one, measured with the same page, data,
 * and driver. */
const latkit = path.resolve(import.meta.dirname, process.env.LATKIT_PACKAGE ?? '../npm');

export default defineConfig({
  plugins: [tiles()],
  resolve: {
    alias: {
      latkit: path.join(latkit, 'dist/index.js'),
      // The package's own bindings, the module it loads, so the page can read the WebAssembly
      // memory of that same instance.
      'latkit-bindings': path.join(latkit, 'pkg/latkit.js'),
    },
  },
  // latkit loads its wasm from beside its own module, which prebundling would move.
  optimizeDeps: { exclude: ['latkit', 'latkit-bindings'] },
  build: { target: 'es2022' },
});
