/** Loading latkit's WebAssembly. */

import init, * as bindings from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { loaded, stop, thrown } from './internal.js';
import { jobs } from './jobs.js';

let configured:
  { wasm?: string | WebAssembly.Module; worker?: string | (() => Worker) } | undefined;
let loading: Promise<void> | undefined;

/** The GPU device requested while loading, kept until the first `Gpu.create()` takes it. */
let first: Promise<bindings.Gpu> | undefined;

/**
 * Loads latkit's WebAssembly, once per page. Later and concurrent calls share the first call's
 * load. Options they pass must equal the first call's, or they reject with an `io` error. A failed
 * load rejects with an `io` error and can be retried. While the WebAssembly compiles, `load()`
 * requests a GPU adapter so the browser starts its GPU process early. Then it requests the first
 * device for `Gpu.create()`.
 */
export function load(
  options: {
    /**
     * The URL of this version's `latkit/wasm` asset, or that asset compiled. Defaults to the
     * bundled asset.
     */
    wasm?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's standalone `latkit/worker` asset, or a function that creates a
     * worker running it. A URL on another origin, such as a CDN, starts through a script on the
     * page's origin, since browsers start workers only from there. Defaults to the bundled worker.
     */
    worker?: string | URL | (() => Worker);
  } = {},
): Promise<void> {
  // Store a URL as text, so the caller cannot change the configuration while it loads.
  const wasm = options.wasm instanceof URL ? options.wasm.href : options.wasm;
  const worker = options.worker instanceof URL ? options.worker.href : options.worker;
  if (loading) {
    if (
      (wasm !== undefined && wasm !== configured?.wasm) ||
      (worker !== undefined && worker !== configured?.worker)
    )
      return Promise.reject(
        thrown({ code: 'io', message: 'latkit is already loading or loaded with other options' }),
      );
    return loading;
  }
  configured = { wasm, worker };
  startGpuProcess();
  loading = initialize(configured).catch((cause: unknown) => {
    configured = undefined;
    loading = undefined;
    throw thrown({ code: 'io', message: 'could not load latkit', cause });
  });
  return loading;
}

/**
 * Instantiates the bindings, installs the job workers and the video encoder where the browser has
 * them, and requests the first GPU device.
 */
async function initialize(options: {
  wasm?: string | WebAssembly.Module;
  worker?: string | (() => Worker);
}) {
  await init(options.wasm === undefined ? undefined : { module_or_path: options.wasm });
  bindings.onStop(stop);
  const worker = typeof options.worker === 'string' ? workerAt(options.worker) : options.worker;
  if (worker || typeof Worker === 'function')
    bindings.setJobs(jobs(bindings.module() as WebAssembly.Module, worker));
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
 * Creates workers running the worker bundle at `url`. One on another origin starts through a blob
 * on the page's origin that imports it.
 */
function workerAt(url: string): () => Worker {
  const page = globalThis.location?.href;
  const href = new URL(url, page).href;
  const script =
    page === undefined || new URL(href).origin === new URL(page).origin
      ? href
      : URL.createObjectURL(
          new Blob([`importScripts(${JSON.stringify(href)});`], { type: 'text/javascript' }),
        );
  return () => new Worker(script);
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
 * Requests a high-performance GPU adapter, like latkit's own request, while the WebAssembly loads.
 * This starts the browser's GPU process early. Starting it takes most of a cold device's 280 ms, so
 * latkit's later request finds the process running.
 */
function startGpuProcess(): void {
  const gpu = (
    globalThis.navigator as
      { gpu?: { requestAdapter(options: object): Promise<unknown> } } | undefined
  )?.gpu;
  gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => {});
}
