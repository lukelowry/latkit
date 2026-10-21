import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The example pages' models, run in node against the built package: `node npm/build.mjs compile npm`
// first.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['npm/examples/src/**/*.test.ts'],
    setupFiles: ['npm/examples/test/setup.ts'],
    // The bunny's simulations take seconds alone, and longer beside the other suites.
    testTimeout: 30_000,
  },
});
