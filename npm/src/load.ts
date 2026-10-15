/** Options for the page's shared WASM runtime. Omitted options reuse its existing configuration. */
export interface LoadOptions {
  /** The matching package's WASM asset, or an already compiled module. Defaults to the bundled asset. */
  wasm?: string | URL | WebAssembly.Module;
  /** Creates a worker running the standalone `latkit/worker` bundle. Defaults to the bundled worker. */
  createWorker?: () => Worker;
}

/** The initialized data and rendering API. GPU devices are requested separately by `Gpu.create()`. */
export type Latkit = Awaited<ReturnType<typeof import('./runtime.js').initialize>>;

let configured: LoadOptions | undefined;
let loading: Promise<Latkit> | undefined;

/**
 * Loads the runtime once per page. Concurrent calls share one promise; a failed load can be retried.
 * Options explicitly supplied after the first call must match that call. Importing the package alone
 * neither initializes WASM nor requests a GPU or worker.
 */
export function loadLatkit(options: LoadOptions = {}): Promise<Latkit> {
  // Snapshot URLs so a caller cannot change the configuration while it loads.
  const wasm = options.wasm instanceof URL ? options.wasm.href : options.wasm;
  if (loading) {
    if (
      (wasm !== undefined && wasm !== configured?.wasm) ||
      (options.createWorker !== undefined && options.createWorker !== configured?.createWorker)
    ) {
      return Promise.reject(
        Object.assign(new Error('latkit is already loading or loaded with different options'), {
          code: 'load',
        }),
      );
    }
    return loading;
  }
  configured = { wasm, createWorker: options.createWorker };
  loading = import('./runtime.js')
    .then((runtime) => runtime.initialize(configured!))
    .catch((cause: unknown) => {
      configured = undefined;
      loading = undefined;
      throw Object.assign(new Error('could not load latkit', { cause }), { code: 'load' });
    });
  return loading;
}
