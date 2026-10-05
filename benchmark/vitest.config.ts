import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'benchmark',
    include: ['*.test.ts'],
    benchmark: { include: ['*.bench.ts'] },
  },
});
