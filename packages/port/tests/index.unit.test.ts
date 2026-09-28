import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import * as entry from '../src/index.js';

describe('port package entrypoint', () => {
  it('publishes only the root entrypoint', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown>; dependencies?: Record<string, string> };
    expect(Object.keys(manifest.exports)).toEqual(['.']);
  });

  it('publishes the transports, the protocol machinery, its checks, and the model and recording services', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'bytePort',
      'check',
      'connect',
      'connectModel',
      'connectRecording',
      'describeError',
      'loopback',
      'messagePort',
      'protocol',
      'serve',
      'serveModel',
      'serveRecording',
      'socketPort',
      'transferred',
    ]);
  });
});
