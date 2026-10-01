import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'monitor-example', include: ['src/source.test.ts'] } });
