import { afterEach, describe, expect, it, vi } from 'vitest';

import { GpuUnavailableError, requestDevice } from '../src/index.js';

interface Harness {
  readonly device: GPUDevice;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly requestAdapter: ReturnType<typeof vi.fn>;
  readonly requestDevice: ReturnType<typeof vi.fn>;
}

function installGpu(): Harness {
  const destroy = vi.fn();
  const device = { destroy } as unknown as GPUDevice;
  const requestDevice = vi.fn(async () => device);
  const adapter = { requestDevice } as unknown as GPUAdapter;
  const requestAdapter = vi.fn(async () => adapter);

  vi.stubGlobal('navigator', { gpu: { requestAdapter } });

  return { device, destroy, requestAdapter, requestDevice };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestDevice', () => {
  it.each([
    ['missing navigator', undefined],
    ['missing GPU entrypoint', {}],
  ])('reports the API stage for %s', async (_label, navigatorValue) => {
    vi.stubGlobal('navigator', navigatorValue);

    const pending = requestDevice();

    await expect(pending).rejects.toMatchObject({
      name: 'GpuUnavailableError',
      stage: 'api',
      message: 'WebGPU is not available in this context',
    });
    await expect(pending).rejects.toBeInstanceOf(GpuUnavailableError);
  });

  it('reports a null Core adapter as unavailable', async () => {
    const requestAdapter = vi.fn(async () => null);
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });

    await expect(requestDevice()).rejects.toMatchObject({
      name: 'GpuUnavailableError',
      stage: 'adapter',
      message: 'No Core WebGPU adapter is available',
    });
    expect(requestAdapter).toHaveBeenCalledWith({ featureLevel: 'core' });
  });

  it('preserves a rejected device request as the typed cause', async () => {
    const cause = new DOMException('blocked for test', 'OperationError');
    const requestDeviceFromAdapter = vi.fn(async () => Promise.reject(cause));
    const requestAdapter = vi.fn(async () => ({ requestDevice: requestDeviceFromAdapter }));
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });

    await expect(requestDevice()).rejects.toMatchObject({
      name: 'GpuUnavailableError',
      stage: 'device',
      cause,
    });
  });

  it('requests Core without imposing a default power preference', async () => {
    const h = installGpu();

    const device = await requestDevice();

    expect(device).toBe(h.device);
    expect(h.requestAdapter).toHaveBeenCalledOnce();
    const request = h.requestAdapter.mock.calls[0]![0] as GPURequestAdapterOptions;
    expect(request).toEqual({ featureLevel: 'core' });
    expect(Object.hasOwn(request, 'powerPreference')).toBe(false);
    expect(Object.hasOwn(request, 'forceFallbackAdapter')).toBe(false);
    expect(h.requestDevice).toHaveBeenCalledWith();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('forwards an explicit power preference without mutating the options', async () => {
    const h = installGpu();
    const options = Object.freeze({ powerPreference: 'low-power' as const });

    await requestDevice(options);

    expect(h.requestAdapter).toHaveBeenCalledWith({
      featureLevel: 'core',
      powerPreference: 'low-power',
    });
    expect(options).toEqual({ powerPreference: 'low-power' });
  });

  it('acquires independently on every call', async () => {
    const first = installGpu();
    const firstDevice = await requestDevice();
    const second = installGpu();
    const secondDevice = await requestDevice();

    expect(firstDevice).toBe(first.device);
    expect(secondDevice).toBe(second.device);
    expect(firstDevice).not.toBe(secondDevice);
    expect(first.requestAdapter).toHaveBeenCalledOnce();
    expect(second.requestAdapter).toHaveBeenCalledOnce();
  });

  it('does not relabel adapter request failures', async () => {
    const cause = new TypeError('adapter request failed');
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: vi.fn(async () => Promise.reject(cause)) },
    });

    await expect(requestDevice()).rejects.toBe(cause);
  });
});
