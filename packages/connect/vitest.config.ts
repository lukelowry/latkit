import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@latkit/connect', include: ['tests/**/*.test.ts'] } });
