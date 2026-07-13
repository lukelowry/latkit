const UNAVAILABLE_MESSAGE = {
  api: 'WebGPU is not available in this context',
  adapter: 'No Core WebGPU adapter is available',
  device: 'A WebGPU device could not be created',
  context: 'A WebGPU canvas context is not available',
} as const;

/** Options used when selecting a WebGPU adapter. */
export interface Options {
  /**
   * Adapter power hint.
   *
   * @remarks
   * Omitted by default so the user agent can choose the appropriate adapter.
   */
  readonly powerPreference?: GPUPowerPreference;
}

/**
 * An owned WebGPU device that can be shared by renderers in one browser realm.
 *
 * @remarks
 * The creator owns this object. Borrowers may use `device`, but only the owner
 * should call `destroy()` after all borrowers are destroyed.
 */
export interface Gpu {
  /** Logical device used to create resources and submit commands. */
  readonly device: GPUDevice;
  /** Preferred texture format for canvases in the current browser realm. */
  readonly format: GPUTextureFormat;
  /** Destroys the logical device. Repeated calls have no effect. */
  destroy(): void;
}

/**
 * Expected environmental failure while preparing WebGPU rendering.
 *
 * @remarks
 * Latkit renderers may use the `context` stage when a canvas cannot provide a
 * WebGPU context. Shader, validation, and other programming failures are not
 * represented by this error.
 */
export class GpuUnavailableError extends Error {
  /** Acquisition stage that could not be completed. */
  readonly stage: 'api' | 'adapter' | 'device' | 'context';

  /**
   * Creates a typed WebGPU availability error.
   *
   * @param stage - Acquisition stage that failed.
   * @param options - Standard error options, including an optional cause.
   */
  constructor(stage: GpuUnavailableError['stage'], options?: ErrorOptions) {
    super(UNAVAILABLE_MESSAGE[stage], options);
    this.name = 'GpuUnavailableError';
    this.stage = stage;
  }
}

/**
 * Creates an owned Core WebGPU device.
 *
 * @param options - Optional adapter-selection hints.
 * @returns A device and preferred canvas format with an idempotent destructor.
 * @throws {@link GpuUnavailableError} when the API, adapter, or device is unavailable.
 *
 * @remarks
 * No power preference is requested by default. The returned object owns its
 * device and must be destroyed by its creator after all borrowers are gone.
 */
export async function createGpu(options: Options = {}): Promise<Gpu> {
  const api = globalThis.navigator?.gpu;
  if (!api) throw new GpuUnavailableError('api');

  const request: GPURequestAdapterOptions = { featureLevel: 'core' };
  if (options.powerPreference !== undefined) {
    request.powerPreference = options.powerPreference;
  }

  const adapter = await api.requestAdapter(request);
  if (!adapter) throw new GpuUnavailableError('adapter');

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (cause) {
    throw new GpuUnavailableError('device', { cause });
  }

  let format: GPUTextureFormat;
  try {
    format = api.getPreferredCanvasFormat();
  } catch (cause) {
    try {
      device.destroy();
    } catch {
      // Preserve the acquisition failure that made the cleanup necessary.
    }
    throw cause;
  }

  let destroyed = false;

  return {
    device,
    format,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      device.destroy();
    },
  };
}
