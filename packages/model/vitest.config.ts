import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@latkit/model', include: ['tests/**/*.test.ts'] },
});
