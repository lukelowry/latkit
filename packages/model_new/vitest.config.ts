import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@latkit/model-new', include: ['tests/**/*.test.ts'] },
});
