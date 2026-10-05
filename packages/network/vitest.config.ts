import { defineConfig } from 'vitest/config';
import { wgsl } from '../../vitest.wgsl';
export default defineConfig({
  plugins: [wgsl],
  test: { name: '@latkit/network', include: ['tests/**/*.test.ts'] },
});
