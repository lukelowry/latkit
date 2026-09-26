import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import type {
  Attachment,
  Frame,
  FrameLoop,
  GpuUnavailableError,
  Options,
  createFrameLoop,
  requestDevice,
} from '../src/index.js';

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
      'createAttachment',
      'createDevicePool',
      'createFrameLoop',
      'createPresentation',
      'devices',
      'requestDevice',
    ]);
    await expect(entrypoint.requestDevice()).rejects.toBeInstanceOf(entrypoint.GpuUnavailableError);
    await expect(entrypoint.devices.acquire()).rejects.toBeInstanceOf(
      entrypoint.GpuUnavailableError,
    );
  });

  it('keeps the public types minimal and exact', () => {
    expectTypeOf<ReturnType<typeof requestDevice>>().toEqualTypeOf<Promise<GPUDevice>>();
    expectTypeOf<Options['powerPreference']>().toEqualTypeOf<GPUPowerPreference | undefined>();
    expectTypeOf<GpuUnavailableError['stage']>().toEqualTypeOf<'api' | 'adapter' | 'device'>();
    expectTypeOf<Parameters<typeof createFrameLoop>[1]>().toEqualTypeOf<
      (frame: Frame) => boolean
    >();
    expectTypeOf<ReturnType<typeof createFrameLoop>>().toEqualTypeOf<FrameLoop>();
    expectTypeOf<keyof Frame>().toEqualTypeOf<
      'now' | 'width' | 'height' | 'backingScale' | 'settled'
    >();
    expectTypeOf<keyof Attachment<unknown>>().toEqualTypeOf<
      'canvas' | 'binding' | 'attach' | 'detach' | 'destroy'
    >();
    expectTypeOf<ReturnType<Attachment<unknown>['attach']>>().toEqualTypeOf<Promise<boolean>>();
  });
});
