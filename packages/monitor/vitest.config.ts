import { defineConfig } from 'vitest/config';
import { wgsl } from '../../vitest.wgsl';
export default defineConfig({
  plugins: [wgsl],
  test: { name: '@latkit/monitor', include: ['tests/**/*.test.ts'] },
});
