import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Gpu, GpuUnavailableError, Options } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gpu package entrypoint', () => {
  it('imports without browser globals and exposes only the intended values', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.resetModules();

    const entrypoint = await import('../src/index.js');

    expect(Object.keys(entrypoint).sort()).toEqual(['GpuUnavailableError', 'createGpu']);
    await expect(entrypoint.createGpu()).rejects.toBeInstanceOf(entrypoint.GpuUnavailableError);
  });

  it('keeps the public types minimal and exact', () => {
    expectTypeOf<Gpu['device']>().toEqualTypeOf<GPUDevice>();
    expectTypeOf<Gpu['format']>().toEqualTypeOf<GPUTextureFormat>();
    expectTypeOf<Gpu['destroy']>().toEqualTypeOf<() => void>();
    expectTypeOf<Options['powerPreference']>().toEqualTypeOf<GPUPowerPreference | undefined>();
    expectTypeOf<GpuUnavailableError['stage']>().toEqualTypeOf<
      'api' | 'adapter' | 'device' | 'context'
    >();
  });
});
