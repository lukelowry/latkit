import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: '@latkit/connect-scale-benchmark',
    include: ['tests/scale/*.perf.ts'],
    testTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
});
