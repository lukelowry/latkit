import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.perf.ts'], testTimeout: 60000 } });
