/** Loading latkit's WebAssembly. */

import init, * as bindings from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { loaded, stop, thrown } from './internal.js';
import { jobs } from './jobs.js';
import { translate } from './wgsl.js';

let configured:
  | { wasm?: string | WebAssembly.Module; shaders?: string; worker?: string | (() => Worker) }
  | undefined;
let loading: Promise<void> | undefined;

/** The GPU device requested while loading, kept until the first `Gpu.create()` takes it. */
let first: Promise<bindings.Gpu> | undefined;

/**
 * Loads latkit's WebAssembly, once per page. Later and concurrent calls share the first call's
 * load. Options they pass must equal the first call's, or they reject with an `io` error. A failed
 * load rejects with an `io` error and can be retried. Where a browser canvas is available, `load()`
 * also downloads the shaders, then creates the first WebGL2 device for `Gpu.create()`.
 */
export function load(
  options: {
    /**
     * The URL of this version's `latkit/wasm` asset, or that asset compiled. Defaults to the
     * bundled asset.
     */
    wasm?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's `latkit/shaders` asset: the shaders translated for WebGL2. Defaults
     * to the bundled asset.
     */
    shaders?: string | URL;
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
  const shaders = options.shaders instanceof URL ? options.shaders.href : options.shaders;
  const worker = options.worker instanceof URL ? options.worker.href : options.worker;
  if (loading) {
    if (
      (wasm !== undefined && wasm !== configured?.wasm) ||
      (shaders !== undefined && shaders !== configured?.shaders) ||
      (worker !== undefined && worker !== configured?.worker)
    )
      return Promise.reject(
        thrown({ code: 'io', message: 'latkit is already loading or loaded with other options' }),
      );
    return loading;
  }
  configured = { wasm, shaders, worker };
  loading = initialize(configured).catch((cause: unknown) => {
    configured = undefined;
    loading = undefined;
    throw thrown({ code: 'io', message: 'could not load latkit', cause });
  });
  return loading;
}

/**
 * Instantiates the bindings, installs the job workers, the WGSL translator, and the video encoder
 * where the browser has them. Where a browser canvas is available, including workers, the shaders
 * download meanwhile, and once handed over, the first GPU device is requested.
 */
async function initialize(options: {
  wasm?: string | WebAssembly.Module;
  shaders?: string;
  worker?: string | (() => Worker);
}) {
  const drawing = typeof OffscreenCanvas === 'function' || typeof document !== 'undefined';
  const shaders = drawing
    ? fetched(options.shaders ?? new URL('../pkg/latkit_shaders.bin', import.meta.url))
    : undefined;
  // Report a failed download once loading awaits it, not as an unhandled rejection if init fails.
  shaders?.catch(() => {});
  await init(options.wasm === undefined ? undefined : { module_or_path: options.wasm });
  if (shaders) bindings.setShaders(await shaders);
  bindings.onStop(stop);
  bindings.setTranslator(translate);
  const worker = typeof options.worker === 'string' ? workerAt(options.worker) : options.worker;
  if (worker || typeof Worker === 'function')
    bindings.setJobs(jobs(bindings.module() as WebAssembly.Module, worker));
  if (typeof VideoEncoder === 'function') bindings.setEncoder(encoder);
  loaded(bindings);
  if (drawing) {
    first = bindings.Gpu.create();
    first.catch(() => {});
  }
}

/** The bytes at `url`. Fails on a status other than 200. */
async function fetched(url: string | URL): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${String(url)} answered HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
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
