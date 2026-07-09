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

describe('createGpuContext', () => {
  it('throws when WebGPU is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    await expect(createGpuContext(canvasWithContext(null))).rejects.toThrow(
      'WebGPU is not available in this browser',
    );
  });

  it('throws when no adapter is available', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: vi.fn(async () => null) },
    });

    await expect(createGpuContext(canvasWithContext(null))).rejects.toThrow(
      'No WebGPU adapter is available',
    );
  });

  it('throws when device acquisition fails', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => ({ requestDevice: vi.fn(async () => null) })),
      },
    });

    await expect(createGpuContext(canvasWithContext(null))).rejects.toThrow(
      'Failed to acquire a WebGPU device',
    );
  });

  it('throws when the canvas cannot provide a WebGPU context', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => ({
          requestDevice: vi.fn(async () => ({ destroy: vi.fn() })),
        })),
      },
    });

    await expect(createGpuContext(canvasWithContext(null))).rejects.toThrow(
      'Canvas does not support a WebGPU context',
    );
  });

  it('configures the canvas context and destroys the acquired device', async () => {
    const device = { destroy: vi.fn() } as unknown as GPUDevice;
    const context = { configure: vi.fn() } as unknown as GPUCanvasContext;
    const canvas = canvasWithContext(context);
    const requestDevice = vi.fn(async () => device);
    const requestAdapter = vi.fn(async () => ({ requestDevice }));
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter,
        getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
      },
    });

    const gpu = await createGpuContext(canvas);
    destroyGpuContext(gpu);

    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
    expect(context.configure).toHaveBeenCalledWith({
      device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
    });
    expect(gpu).toEqual({ device, context, format: 'bgra8unorm', canvas });
    expect(device.destroy).toHaveBeenCalledOnce();
  });
});
