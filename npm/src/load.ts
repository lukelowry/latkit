/** Loading latkit's WebAssembly: once a page, before data, views, and pictures can be made. */

import init, * as bindings from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { loaded, thrown } from './internal.js';
import { jobs } from './jobs.js';

/** How latkit loads. Options left out keep what loading began with. */
export interface LoadOptions {
  /** The matching package's WASM asset, or an already compiled module. Defaults to the bundled asset. */
  wasm?: string | URL | WebAssembly.Module;
  /** Makes a worker running the standalone `latkit/worker` bundle. Defaults to the bundled worker. */
  worker?: () => Worker;
}

let configured: { wasm?: string | WebAssembly.Module; worker?: () => Worker } | undefined;
let loading: Promise<void> | undefined;

/** The page's first device, made as latkit loads, until `Gpu.create()` takes it. */
let first: Promise<bindings.Gpu> | undefined;

/**
 * Loads latkit's WebAssembly once a page: data, views, and pictures can be made once it resolves.
 * Concurrent calls share one load, and a failed one can be tried again; options given after the first
 * call must match it. Importing the package neither loads WebAssembly nor asks for a GPU; loading asks
 * for the page's GPU adapter while the WebAssembly compiles. `Gpu.create`, `Data.read`, and
 * `Patch.read` load it themselves.
 */
export function load(options: LoadOptions = {}): Promise<void> {
  // URLs as text, so a caller cannot change the configuration while it loads.
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

/** Initializes the bindings, their workers and video encoder, and the page's first device. */
async function initialize(options: { wasm?: string | WebAssembly.Module; worker?: () => Worker }) {
  await init(options.wasm === undefined ? undefined : { module_or_path: options.wasm });
  if (options.worker || typeof Worker === 'function')
    bindings.setJobs(jobs(bindings.module() as WebAssembly.Module, options.worker));
  if (typeof VideoEncoder === 'function') bindings.setEncoder(encoder);
  loaded();
  // The page's first device is made now, so the page does not wait for it when it draws; it
  // compiles nothing until a view opens.
  if ((globalThis.navigator as { gpu?: unknown } | undefined)?.gpu) {
    first = bindings.Gpu.create();
    first.catch(() => {});
  }
}

/** @internal The page's first device, once: what `Gpu.create()` takes before it asks for another. */
export function firstDevice(): Promise<bindings.Gpu> | undefined {
  const device = first;
  first = undefined;
  return device;
}

/**
 * Asks for a GPU adapter as latkit's own request does, while the WebAssembly loads: the browser starts
 * its GPU process meanwhile, which takes most of a cold device's 280 ms, and latkit's request finds it
 * running.
 */
function startGpuProcess(): void {
  const gpu = (
    globalThis.navigator as
      { gpu?: { requestAdapter(options: object): Promise<unknown> } } | undefined
  )?.gpu;
  gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => {});
}
