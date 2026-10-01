import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@latkit/diagram-example', include: ['tests/**/*.test.ts'] },
});
