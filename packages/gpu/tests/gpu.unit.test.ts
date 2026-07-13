import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGpu, GpuUnavailableError } from '../src/index.js';

interface Harness {
  readonly device: GPUDevice;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly getPreferredCanvasFormat: ReturnType<typeof vi.fn>;
  readonly requestAdapter: ReturnType<typeof vi.fn>;
  readonly requestDevice: ReturnType<typeof vi.fn>;
}

function installGpu(): Harness {
  const destroy = vi.fn();
  const device = { destroy } as unknown as GPUDevice;
  const requestDevice = vi.fn(async () => device);
  const adapter = { requestDevice } as unknown as GPUAdapter;
  const requestAdapter = vi.fn(async () => adapter);
  const getPreferredCanvasFormat = vi.fn(() => 'bgra8unorm' as GPUTextureFormat);

  vi.stubGlobal('navigator', {
    gpu: { requestAdapter, getPreferredCanvasFormat },
  });

  return {
    device,
    destroy,
    getPreferredCanvasFormat,
    requestAdapter,
    requestDevice,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGpu', () => {
  it.each([
    ['missing navigator', undefined],
    ['missing GPU entrypoint', {}],
  ])('reports the API stage for %s', async (_label, navigatorValue) => {
    vi.stubGlobal('navigator', navigatorValue);

    const pending = createGpu();

    await expect(pending).rejects.toMatchObject({
      name: 'GpuUnavailableError',
      stage: 'api',
      message: 'WebGPU is not available in this context',
    });
    await expect(pending).rejects.toBeInstanceOf(GpuUnavailableError);
  });

  it('reports a null Core adapter as unavailable', async () => {
    const requestAdapter = vi.fn(async () => null);
    const getPreferredCanvasFormat = vi.fn();
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter, getPreferredCanvasFormat },
    });

    await expect(createGpu()).rejects.toMatchObject({
      name: 'GpuUnavailableError',
      stage: 'adapter',
      message: 'No Core WebGPU adapter is available',
    });
    expect(requestAdapter).toHaveBeenCalledWith({ featureLevel: 'core' });
    expect(getPreferredCanvasFormat).not.toHaveBeenCalled();
  });

  it('preserves a rejected device request as the typed cause', async () => {
    const cause = new DOMException('blocked for test', 'OperationError');
    const requestDevice = vi.fn(async () => Promise.reject(cause));
    const requestAdapter = vi.fn(async () => ({ requestDevice }));
    const getPreferredCanvasFormat = vi.fn();
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter, getPreferredCanvasFormat },
    });

    const pending = createGpu();

    await expect(pending).rejects.toMatchObject({
      name: 'GpuUnavailableError',
      stage: 'device',
      cause,
    });
    expect(getPreferredCanvasFormat).not.toHaveBeenCalled();
  });

  it('requests Core without imposing a default power preference', async () => {
    const h = installGpu();

    const gpu = await createGpu();

    expect(h.requestAdapter).toHaveBeenCalledOnce();
    const request = h.requestAdapter.mock.calls[0]![0] as GPURequestAdapterOptions;
    expect(request).toEqual({ featureLevel: 'core' });
    expect(Object.hasOwn(request, 'powerPreference')).toBe(false);
    expect(Object.hasOwn(request, 'forceFallbackAdapter')).toBe(false);
    expect(h.requestDevice).toHaveBeenCalledWith();
    expect(h.getPreferredCanvasFormat).toHaveBeenCalledOnce();
    expect(h.destroy).not.toHaveBeenCalled();
    gpu.destroy();
  });

  it('forwards an explicit power preference without mutating the options', async () => {
    const h = installGpu();
    const options = Object.freeze({ powerPreference: 'low-power' as const });

    const gpu = await createGpu(options);

    expect(h.requestAdapter).toHaveBeenCalledWith({
      featureLevel: 'core',
      powerPreference: 'low-power',
    });
    expect(options).toEqual({ powerPreference: 'low-power' });
    gpu.destroy();
  });

  it('returns the acquired device and preferred canvas format', async () => {
    const h = installGpu();

    const gpu = await createGpu();

    expect(gpu.device).toBe(h.device);
    expect(gpu.format).toBe('bgra8unorm');
    gpu.destroy();
  });

  it('destroys the device exactly once', async () => {
    const h = installGpu();
    const gpu = await createGpu();

    gpu.destroy();
    gpu.destroy();

    expect(h.destroy).toHaveBeenCalledOnce();
  });

  it('acquires independently on every call', async () => {
    const first = installGpu();
    const firstGpu = await createGpu();
    const second = installGpu();
    const secondGpu = await createGpu();

    expect(firstGpu).not.toBe(secondGpu);
    expect(firstGpu.device).toBe(first.device);
    expect(secondGpu.device).toBe(second.device);
    expect(first.requestAdapter).toHaveBeenCalledOnce();
    expect(second.requestAdapter).toHaveBeenCalledOnce();

    firstGpu.destroy();
    secondGpu.destroy();
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it('does not relabel adapter request failures', async () => {
    const cause = new TypeError('adapter request failed');
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => Promise.reject(cause)),
        getPreferredCanvasFormat: vi.fn(),
      },
    });

    await expect(createGpu()).rejects.toBe(cause);
  });

  it('destroys the device and preserves a preferred-format failure', async () => {
    const h = installGpu();
    const cause = new Error('format failed');
    h.getPreferredCanvasFormat.mockImplementation(() => {
      throw cause;
    });
    h.destroy.mockImplementation(() => {
      throw new Error('cleanup failed');
    });

    await expect(createGpu()).rejects.toBe(cause);
    expect(h.destroy).toHaveBeenCalledOnce();
  });
});

describe('GpuUnavailableError', () => {
  it('supports the renderer-owned context stage', () => {
    const cause = new Error('no context');
    const error = new GpuUnavailableError('context', { cause });

    expect(error).toMatchObject({
      name: 'GpuUnavailableError',
      stage: 'context',
      message: 'A WebGPU canvas context is not available',
      cause,
    });
  });
});
