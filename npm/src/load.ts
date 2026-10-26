/** Loading latkit's WebAssembly. */

import init, * as bindings from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { loaded, thrown } from './internal.js';
import { jobs } from './jobs.js';

/** Options for {@link load}. Only the first call's options take effect. */
export interface LoadOptions {
  /**
   * The URL of this package version's `latkit/wasm` asset, or that asset already compiled.
   * Defaults to the bundled asset.
   */
  wasm?: string | URL | WebAssembly.Module;
  /**
   * Creates a worker that runs the standalone `latkit/worker` bundle. Defaults to the bundled
   * worker.
   */
  worker?: () => Worker;
}

let configured: { wasm?: string | WebAssembly.Module; worker?: () => Worker } | undefined;
let loading: Promise<void> | undefined;

/** The GPU device requested while loading, kept until the first `Gpu.create()` takes it. */
let first: Promise<bindings.Gpu> | undefined;

/**
 * Loads latkit's WebAssembly, once per page. Datasets, views, and pictures can be created once it
 * resolves. Later and concurrent calls share the first call's load. Options they pass must equal
 * the first call's, or they reject with an `io` error. A failed load rejects with an `io` error and
 * can be retried.
 *
 * Importing the package loads nothing and requests no GPU. `load()` requests a GPU adapter while
 * the WebAssembly compiles, so the browser starts its GPU process early, then requests the first
 * GPU device for `Gpu.create()`. `Gpu.create()` and `Data.read()` call `load()` themselves, as does
 * `Patch.read()` for JSON.
 */
export function load(options: LoadOptions = {}): Promise<void> {
  // Store a URL as text, so the caller cannot change the configuration while it loads.
  const wasm = options.wasm instanceof URL ? options.wasm.href : options.wasm;
  if (loading) {
    if (
      (wasm !== undefined && wasm !== configured?.wasm) ||
      (options.worker !== undefined && options.worker !== configured?.worker)
    )
      return Promise.reject(
        thrown({ code: 'io', message: 'latkit is already loading or loaded with other options' }),
      );
    return loading;
  }
  configured = { wasm, worker: options.worker };
  startGpuProcess();
  loading = initialize(configured).catch((cause: unknown) => {
    configured = undefined;
    loading = undefined;
    throw Object.assign(thrown({ code: 'io', message: 'could not load latkit' }), { cause });
  });
  return loading;
}

/**
 * Instantiates the bindings, installs the job workers and the video encoder where the browser has
 * them, and requests the first GPU device.
 */
async function initialize(options: { wasm?: string | WebAssembly.Module; worker?: () => Worker }) {
  await init(options.wasm === undefined ? undefined : { module_or_path: options.wasm });
  if (options.worker || typeof Worker === 'function')
    bindings.setJobs(jobs(bindings.module() as WebAssembly.Module, options.worker));
  if (typeof VideoEncoder === 'function') bindings.setEncoder(encoder);
  loaded();
  // Request the first device now, so drawing does not wait for it later. The device compiles
  // nothing until a view is created.
  if ((globalThis.navigator as { gpu?: unknown } | undefined)?.gpu) {
    first = bindings.Gpu.create();
    first.catch(() => {});
  }
}

/**
 * @internal Returns the device requested while loading, once. Later calls return `undefined`, and
 * `Gpu.create()` requests a new device.
 */
export function firstDevice(): Promise<bindings.Gpu> | undefined {
  const device = first;
  first = undefined;
  return device;
}

/**
 * Requests a high-performance GPU adapter, as latkit's own request does, while the WebAssembly
 * loads. This starts the browser's GPU process early. Starting it is most of a cold device's
 * 280 ms, so latkit's own request later finds the process running.
 */
function startGpuProcess(): void {
  const gpu = (
    globalThis.navigator as
      { gpu?: { requestAdapter(options: object): Promise<unknown> } } | undefined
  )?.gpu;
  gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => {});
}
