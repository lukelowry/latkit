import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@latkit/video', include: ['tests/**/*.test.ts'] },
});
