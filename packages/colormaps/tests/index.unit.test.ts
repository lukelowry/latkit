import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import * as entry from '../src/index.js';

describe('colormaps package entrypoint', () => {
  it('publishes only the root entrypoint', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown>; dependencies?: Record<string, string> };
    expect(Object.keys(manifest.exports)).toEqual(['.']);
    expect(manifest.dependencies).toBeUndefined();
  });

  it('publishes the colormap catalog, its functions, and the color checks', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'COLORMAPS',
      'colormap',
      'gradient',
      'parseColor',
      'validateRgba',
    ]);
  });
});
