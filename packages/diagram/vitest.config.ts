import { defineConfig } from 'vitest/config';
import { wgsl } from '../../vitest.wgsl';
export default defineConfig({
  plugins: [wgsl],
  test: { name: '@latkit/diagram', include: ['tests/**/*.test.ts'] },
});
