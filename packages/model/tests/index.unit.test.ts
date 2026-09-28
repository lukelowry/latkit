import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import * as entry from '../src/index.js';

describe('model package entrypoint', () => {
  it('publishes only the root entrypoint', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown>; dependencies?: Record<string, string> };
    expect(Object.keys(manifest.exports)).toEqual(['.']);
    expect(manifest.dependencies).toBeUndefined();
  });

  it('publishes the classes a format, an engine, and an editor build on, and the checks a host runs before a device exists', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'Document',
      'DocumentConflict',
      'Engine',
      'Model',
      'Recording',
      'Refusal',
      'Series',
      'extent',
      'formatNumber',
      'normalizeDomain',
      'validateDomain',
      'validateNetlist',
      'validateSeries',
      'validateTopology',
    ]);
  });
});
