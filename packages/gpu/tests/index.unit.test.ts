import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import type { GpuUnavailableError, Options, requestDevice } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gpu package entrypoint', () => {
  it('builds and publishes only the root entrypoint', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    const build = (await import('../tsup.config.js')).default;

    expect(Object.keys(manifest.exports)).toEqual(['.']);
    expect(build).toMatchObject({ entry: ['src/index.ts'] });
  });

  it('imports without browser globals and exposes only the intended values', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.resetModules();

    const entrypoint = await import('../src/index.js');

    expect(Object.keys(entrypoint).sort()).toEqual([
      'GpuUnavailableError',
      'createDevicePool',
      'createPresentation',
      'requestDevice',
    ]);
    await expect(entrypoint.requestDevice()).rejects.toBeInstanceOf(entrypoint.GpuUnavailableError);
  });

  it('keeps the public types minimal and exact', () => {
    expectTypeOf<ReturnType<typeof requestDevice>>().toEqualTypeOf<Promise<GPUDevice>>();
    expectTypeOf<Options['powerPreference']>().toEqualTypeOf<GPUPowerPreference | undefined>();
    expectTypeOf<GpuUnavailableError['stage']>().toEqualTypeOf<'api' | 'adapter' | 'device'>();
  });
});
