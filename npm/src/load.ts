/** Options for the page's shared WASM runtime. Omitted options reuse its existing configuration. */
export interface LoadOptions {
  /** The matching package's WASM asset, or an already compiled module. Defaults to the bundled asset. */
  wasm?: string | URL | WebAssembly.Module;
  /** Creates a worker running the standalone `latkit/worker` bundle. Defaults to the bundled worker. */
  createWorker?: () => Worker;
}

/**
 * The initialized data and rendering API. In a browser the page's first GPU is made as the runtime
 * loads, and the first `Gpu.create()` takes it; later calls request devices of their own.
 */
export interface Latkit {
  Data: typeof import('./runtime.js').Data;
  Gpu: typeof import('./runtime.js').Gpu;
  Shot: typeof import('./runtime.js').Shot;
  colormapCss: typeof import('./runtime.js').colormapCss;
}

let configured: LoadOptions | undefined;
let loading: Promise<Latkit> | undefined;
/** The adapter asked for as the runtime loads, until the page's first GPU takes it. */
let adapter: Promise<unknown> | undefined;

/**
 * Loads the runtime once per page. Concurrent calls share one promise; a failed load can be retried.
 * Options explicitly supplied after the first call must match that call. Importing the package alone
 * neither initializes WASM nor requests a GPU or worker; loading asks for the page's GPU adapter
 * while the WASM compiles.
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
          code: 'io',
        }),
      );
    }
    return loading;
  }
  configured = { wasm, createWorker: options.createWorker };
  askAdapter();
  loading = import('./runtime.js')
    .then((runtime) => runtime.initialize(configured!))
    .catch((cause: unknown) => {
      configured = undefined;
      loading = undefined;
      throw Object.assign(new Error('could not load latkit', { cause }), { code: 'io' });
    });
  return loading;
}

/**
 * Asks for the page's GPU adapter as latkit's own request does, while the runtime loads: the browser
 * starts its GPU process meanwhile, which takes most of a cold device's 280 ms.
 */
function askAdapter(): void {
  const gpu = (
    globalThis.navigator as
      { gpu?: { requestAdapter(options: object): Promise<unknown> } } | undefined
  )?.gpu;
  adapter = gpu?.requestAdapter({ powerPreference: 'high-performance' });
  adapter?.catch(() => {});
}

/** @internal The adapter asked for as the runtime loaded, once: the page's first GPU is made on it. */
export function takeAdapter(): Promise<unknown> | undefined {
  const taken = adapter;
  adapter = undefined;
  return taken;
}
