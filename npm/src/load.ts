/** Loading latkit's WebAssembly. */

import init, * as bindings from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { loaded, stop, thrown } from './internal.js';
import { compiled, jobs } from './jobs.js';
import { translator } from './wgsl.js';

interface Configured {
  wasm?: string | WebAssembly.Module;
  jobs?: string | WebAssembly.Module;
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
 *
 * The assets come as a set. Without options, latkit finds each beside its own module. A page that
 * gives the URL of `wasm` gives `jobs` and `worker` too, or the call rejects with an `invalid`
 * error: a job would otherwise fail only when a view first has one.
 */
export function load(
  options: {
    /**
     * The URL of this version's `latkit/wasm` asset, or that asset compiled. It carries the
     * shaders, translated for WebGL2 when the package was built. Defaults to the bundled asset.
     */
    wasm?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's `latkit/jobs` asset, the WebAssembly that does the work views and
     * datasets hand to workers, or that asset compiled. A page loads it the first time it has
     * such work. Defaults to the bundled asset.
     */
    jobs?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's `latkit/wgsl` asset, the WebAssembly that translates custom
     * markers' WGSL, or that asset compiled. A page loads it the first time it draws a custom
     * marker. Defaults to the bundled asset.
     */
    wgsl?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's standalone `latkit/worker` asset, which runs the jobs module, or
     * a function that creates a worker running it. A browser starts workers only from the page's
     * origin, so the page fetches a worker on another origin, such as a CDN or a webview's
     * resources, and starts it from a blob. Defaults to the bundled worker.
     */
    worker?: string | URL | (() => Worker);
  } = {},
): Promise<void> {
  // Store a URL as text, so the caller cannot change the configuration while it loads.
  const text = <T>(value: T | URL) => (value instanceof URL ? value.href : value);
  const asked: Configured = {
    wasm: text(options.wasm),
    jobs: text(options.jobs),
    wgsl: text(options.wgsl),
    worker: text(options.worker),
  };
  if (typeof asked.wasm === 'string') {
    // Where no worker can start, jobs run on this thread and need only their module.
    const set = typeof Worker === 'function' ? (['jobs', 'worker'] as const) : (['jobs'] as const);
    const missing = set.find((asset) => asked[asset] === undefined);
    if (missing)
      return Promise.reject(
        thrown({
          code: 'invalid',
          path: missing,
          message: `load() was given the URL of wasm: give it ${missing} from the same version too`,
        }),
      );
  }
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
 * Instantiates the bindings, installs the jobs, the WGSL translator, and the video encoder where
 * the browser has one. The jobs module and its workers load when there is a first job. A worker
 * on another origin is fetched meanwhile. Where a browser canvas is available, including workers,
 * the first GPU device is then requested.
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
  const module = compiled(
    options.jobs ?? new URL('../pkg/latkit_jobs_bg.wasm', import.meta.url).href,
  );
  bindings.setJobs(jobs(module, await worker));
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
