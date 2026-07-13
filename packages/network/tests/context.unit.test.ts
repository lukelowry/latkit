/// <reference types="@webgpu/types" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGpuContext, destroyGpuContext } from '../src/webgpu/context.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function canvasWithContext(context: GPUCanvasContext | null): HTMLCanvasElement {
  return {
    getContext: vi.fn((kind: string) => (kind === 'webgpu' ? context : null)),
  } as unknown as HTMLCanvasElement;
}

function makeDevice(): { readonly device: GPUDevice; readonly destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  return { device: { destroy } as unknown as GPUDevice, destroy };
}

describe('createGpuContext', () => {
  it('throws when the canvas cannot provide a WebGPU context', () => {
    const { device } = makeDevice();

    expect(() => createGpuContext(device, canvasWithContext(null))).toThrow(
      'Canvas does not support a WebGPU context',
    );
  });

  it('queries the presentation format and configures the canvas with a borrowed device', () => {
    const { device, destroy } = makeDevice();
    const context = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
    } as unknown as GPUCanvasContext;
    const canvas = canvasWithContext(context);
    const getPreferredCanvasFormat = vi.fn(() => 'bgra8unorm' as GPUTextureFormat);
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat } });

    const gpu = createGpuContext(device, canvas);
    destroyGpuContext(gpu);

    expect(getPreferredCanvasFormat).toHaveBeenCalledOnce();
    expect(context.configure).toHaveBeenCalledWith({
      device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
    });
    expect(gpu).toEqual({ device, context, format: 'bgra8unorm', canvas });
    expect(context.unconfigure).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('preserves preferred-format lookup errors', () => {
    const { device } = makeDevice();
    const failure = new Error('format lookup failed');
    const context = { configure: vi.fn() } as unknown as GPUCanvasContext;
    vi.stubGlobal('navigator', {
      gpu: {
        getPreferredCanvasFormat: vi.fn(() => {
          throw failure;
        }),
      },
    });

    let caught: unknown;
    try {
      createGpuContext(device, canvasWithContext(context));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(context.configure).not.toHaveBeenCalled();
  });

  it('unconfigures partial setup and preserves configuration errors', () => {
    const { device, destroy } = makeDevice();
    const failure = new Error('configuration failed');
    const context = {
      configure: vi.fn(() => {
        throw failure;
      }),
      unconfigure: vi.fn(() => {
        throw new Error('cleanup also failed');
      }),
    } as unknown as GPUCanvasContext;
    vi.stubGlobal('navigator', {
      gpu: { getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm') },
    });

    let caught: unknown;
    try {
      createGpuContext(device, canvasWithContext(context));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(context.unconfigure).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });
});
