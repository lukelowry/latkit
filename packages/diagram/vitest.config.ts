import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@latkit/diagram', include: ['tests/**/*.test.ts'] },
});
