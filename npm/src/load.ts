/** Loading latkit's WebAssembly. */

import init, * as bindings from '../pkg/latkit.js';
import { encoder } from './encoder.js';
import { loaded, stop, thrown } from './internal.js';
import { jobs } from './jobs.js';
import { translator } from './wgsl.js';

interface Configured {
  wasm?: string | WebAssembly.Module;
  shaders?: string;
  wgsl?: string | WebAssembly.Module;
  worker?: string | (() => Worker);
}

let configured: Configured | undefined;
let loading: Promise<void> | undefined;

/** The shaders' download and handover, while it runs or once it succeeded. */
let shaders: Promise<void> | undefined;

/** The GPU device requested while loading, kept until the first `Gpu.create()` takes it. */
let first: Promise<bindings.Gpu> | undefined;

/**
 * Loads latkit's WebAssembly, once per page. Later and concurrent calls share the first call's
 * load. Options they pass must equal the first call's, or they reject with an `io` error. A failed
 * load rejects with an `io` error and can be retried. Where a browser canvas is available, `load()`
 * also downloads the shaders, then creates the first WebGL2 device for `Gpu.create()`. Only
 * drawing needs the shaders, so a failed download fails `Gpu.create()`, not `load()`.
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
     * The URL of this version's `latkit/wgsl` asset, the WebAssembly that translates custom
     * markers' WGSL, or that asset compiled. A page loads it the first time it draws a custom
     * marker. Defaults to the bundled asset.
     */
    wgsl?: string | URL | WebAssembly.Module;
    /**
     * The URL of this version's standalone `latkit/worker` asset, or a function that creates a
     * worker running it. A URL on another origin, such as a CDN, starts through a script on the
     * page's origin, since browsers start workers only from there. Defaults to the bundled worker.
     */
    worker?: string | URL | (() => Worker);
  } = {},
): Promise<void> {
  // Store a URL as text, so the caller cannot change the configuration while it loads.
  const text = <T>(value: T | URL) => (value instanceof URL ? value.href : value);
  const asked: Configured = {
    wasm: text(options.wasm),
    shaders: text(options.shaders),
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
 * where the browser has them. Where a browser canvas is available, including workers, the shaders
 * download meanwhile, and once handed over, the first GPU device is requested.
 */
async function initialize(options: Configured) {
  const drawing = typeof OffscreenCanvas === 'function' || typeof document !== 'undefined';
  const instantiated = init(
    options.wasm === undefined ? undefined : { module_or_path: options.wasm },
  );
  const handed = drawing ? download(instantiated) : undefined;
  await instantiated;
  bindings.onStop(stop);
  bindings.setTranslator(translator(options.wgsl));
  const worker = typeof options.worker === 'string' ? workerAt(options.worker) : options.worker;
  if (worker || typeof Worker === 'function')
    bindings.setJobs(jobs(bindings.module() as WebAssembly.Module, worker));
  if (typeof VideoEncoder === 'function') bindings.setEncoder(encoder);
  loaded(bindings);
  if (handed) {
    const device = handed.then(() => bindings.Gpu.create());
    device.catch(() => {});
    first = device;
    // A failed download leaves no device for `Gpu.create()` to take: it downloads again.
    handed.catch(() => {
      if (first === device) first = undefined;
    });
  }
}

/**
 * Downloads the shaders meanwhile, and hands them over once `instantiated` resolves. A failure
 * rejects with an `io` error, and the next `Gpu.create()` downloads them again.
 */
function download(instantiated: Promise<unknown>): Promise<void> {
  const at = configured?.shaders ?? new URL('../pkg/latkit_shaders.bin', import.meta.url);
  const bytes = fetched(at);
  const handed = Promise.all([bytes, instantiated]).then(([shaders]) =>
    bindings.setShaders(shaders),
  );
  const tried: Promise<void> = handed.catch((cause: unknown) => {
    if (shaders === tried) shaders = undefined;
    throw thrown({
      code: 'io',
      message: `could not load latkit's shaders from ${String(at)}`,
      cause,
    });
  });
  tried.catch(() => {});
  shaders = tried;
  return tried;
}

/**
 * @internal Resolves once the shaders are handed over, downloading them again if the last download
 * failed. Rejects with an `io` error if they cannot be. Without a browser canvas, there is nothing
 * to draw on, and it resolves at once.
 */
export function shadersLoaded(): Promise<void> {
  const drawing = typeof OffscreenCanvas === 'function' || typeof document !== 'undefined';
  if (!drawing) return Promise.resolve();
  return shaders ?? download(Promise.resolve());
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
