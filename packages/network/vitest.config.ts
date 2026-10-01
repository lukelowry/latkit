import { defineConfig } from 'vitest/config';
import { readFile } from 'node:fs/promises';
export default defineConfig({
  plugins: [
    {
      name: 'wgsl',
      async load(id) {
        if (id.endsWith('.wgsl'))
          return 'export default ' + JSON.stringify(await readFile(id, 'utf8'));
      },
    },
  ],
  test: { name: '@latkit/network', include: ['tests/**/*.test.ts'] },
});
