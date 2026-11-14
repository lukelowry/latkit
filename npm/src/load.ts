/** Loading latkit's WebAssembly. */

import init, * as bindings from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { loaded, stop, thrown } from './internal.js';
import { jobs } from './jobs.js';
import { translator } from './wgsl.js';

interface Configured {
  wasm?: string | WebAssembly.Module;
  wgsl?: string | WebAssembly.Module;
  worker?: string | (() => Worker);
}

let configured: Configured | undefined;
let loading: Promise<void> | undefined;

/** The GPU device requested while loading, kept until the first `Gpu.create()` takes it. */
let first: Promise<bindings.Gpu> | undefined;

/**
 * Loads latkit's WebAssembly, once per page. Later and concurrent calls share the first call's
 * load. Options they pass must equal the first call's, or they reject with an `io` error. A failed
 * load rejects with an `io` error and can be retried. Where a browser canvas is available, `load()`
 * also creates the first WebGL2 device for `Gpu.create()`.
 */
export function load(
  options: {
    /**
     * The URL of this version's `latkit/wasm` asset, or that asset compiled. It carries the
     * shaders, translated for WebGL2 when the package was built. Defaults to the bundled asset.
     */
    wasm?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's `latkit/wgsl` asset, the WebAssembly that translates custom
     * markers' WGSL, or that asset compiled. A page loads it the first time it draws a custom
     * marker. Defaults to the bundled asset.
     */
    wgsl?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's standalone `latkit/worker` asset, or a function that creates a
     * worker running it. A browser starts workers only from the page's origin, so the page fetches
     * a worker on another origin, such as a CDN or a webview's resources, and starts it from a
     * blob. Defaults to the bundled worker.
     */
    worker?: string | URL | (() => Worker);
  } = {},
): Promise<void> {
  // Store a URL as text, so the caller cannot change the configuration while it loads.
  const text = <T>(value: T | URL) => (value instanceof URL ? value.href : value);
  const asked: Configured = {
    wasm: text(options.wasm),
    wgsl: text(options.wgsl),
    worker: text(options.worker),
  };
  if (loading) {
    const differs = (Object.keys(asked) as (keyof Configured)[]).some(
      (key) => asked[key] !== undefined && asked[key] !== configured?.[key],
    );
    if (differs)
      return Promise.reject(
        thrown({ code: 'io', message: 'latkit is already loading or loaded with other options' }),
      );
    return loading;
  }
  configured = asked;
  loading = initialize(configured).catch((cause: unknown) => {
    configured = undefined;
    loading = undefined;
    throw thrown({ code: 'io', message: 'could not load latkit', cause });
  });
  return loading;
}

/**
 * Instantiates the bindings, installs the job workers, the WGSL translator, and the video encoder
 * where the browser has them. A worker on another origin is fetched meanwhile. Where a browser
 * canvas is available, including workers, the first GPU device is then requested.
 */
async function initialize(options: Configured) {
  const instantiated = init(
    options.wasm === undefined ? undefined : { module_or_path: options.wasm },
  );
  const worker =
    typeof options.worker === 'function'
      ? Promise.resolve(options.worker)
      : typeof Worker === 'function'
        ? workerAt(options.worker ?? new URL('./worker.js', import.meta.url).href)
        : undefined;
  await instantiated;
  bindings.onStop(stop);
  bindings.setTranslator(translator(options.wgsl));
  if (worker) bindings.setJobs(jobs(bindings.module() as WebAssembly.Module, await worker));
  if (typeof VideoEncoder === 'function') bindings.setEncoder(encoder);
  loaded(bindings);
  if (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined') {
    const device = bindings.Gpu.create();
    device.catch(() => {});
    first = device;
  }
}

/**
 * Creates workers running the worker bundle at `url`. A browser starts workers only from the
 * page's origin, so the page fetches a bundle on another origin and starts it from a blob. If that
 * fetch fails, each job fails with an `io` error.
 */
async function workerAt(url: string): Promise<() => Worker> {
  const page = globalThis.location?.href;
  const href = new URL(url, page).href;
  if (page === undefined || new URL(href).origin === new URL(page).origin)
    return () => new Worker(href);
  try {
    const response = await fetch(href);
    if (!response.ok) throw new Error(`${href} answered HTTP ${response.status}`);
    const script = URL.createObjectURL(
      new Blob([await response.arrayBuffer()], { type: 'text/javascript' }),
    );
    return () => new Worker(script);
  } catch (cause) {
    const error = thrown({
      code: 'io',
      message: `could not load latkit's worker from ${href}`,
      cause,
    });
    return () => {
      throw error;
    };
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
