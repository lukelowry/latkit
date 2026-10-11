import { defineConfig } from 'vitest/config';
import { wgsl } from '../../vitest.wgsl';
import { vitestWorker } from './worker.config';
export default defineConfig({
  plugins: [wgsl, vitestWorker],
  test: { name: '@latkit/geography', include: ['tests/**/*.test.ts'] },
});
