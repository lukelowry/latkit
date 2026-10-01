import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: '@latkit/gpu',
    include: ['tests/**/*.test.ts'],
    benchmark: { include: ['tests/**/*.bench.ts'] },
  },
});
