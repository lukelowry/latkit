const UNAVAILABLE_MESSAGE = {
  api: 'WebGPU is not available in this context',
  adapter: 'No Core WebGPU adapter is available',
  device: 'A WebGPU device could not be created',
} as const;

/** Options used when selecting a WebGPU adapter. */
export interface Options {
  /**
   * Adapter power hint.
   *
   * @remarks
   * Omitted by default so the user agent can choose the appropriate adapter.
   */
  powerPreference?: GPUPowerPreference;
}

/** Expected environmental failure while requesting a WebGPU device. */
export class GpuUnavailableError extends Error {
  /** Request stage that could not be completed. */
  readonly stage: 'api' | 'adapter' | 'device';

  /**
   * Creates a typed WebGPU availability error.
   *
   * @param stage - Device-request stage that failed.
   * @param options - Standard error options, including an optional cause.
   */
  constructor(stage: GpuUnavailableError['stage'], options?: ErrorOptions) {
    super(UNAVAILABLE_MESSAGE[stage], options);
    this.name = 'GpuUnavailableError';
    this.stage = stage;
  }
}

/**
 * Requests a Core WebGPU device.
 *
 * @param options - Optional adapter-selection hints.
 * @returns The native Core device owned by the caller.
 * @throws {@link GpuUnavailableError} when the API, adapter, or device is unavailable.
 *
 * @remarks
 * No power preference is requested by default. The caller must destroy the
 * device after every renderer and resource that borrows it has been destroyed.
 */
export async function requestDevice(options: Options = {}): Promise<GPUDevice> {
  const api = globalThis.navigator?.gpu;
  if (!api) throw new GpuUnavailableError('api');

  const adapterOptions: GPURequestAdapterOptions = { featureLevel: 'core' };
  if (options.powerPreference !== undefined) {
    adapterOptions.powerPreference = options.powerPreference;
  }

  const adapter = await api.requestAdapter(adapterOptions);
  if (!adapter) throw new GpuUnavailableError('adapter');

  try {
    return await adapter.requestDevice();
  } catch (cause) {
    throw new GpuUnavailableError('device', { cause });
  }
}
