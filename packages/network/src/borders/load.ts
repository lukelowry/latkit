/**
 * `@latkit/network/borders` — the packaged Natural Earth 50m line borders (coastlines, land
 * boundaries, state and province lines) in the `Borders` layout the renderer consumes. Loaded from
 * the package's own assets and decoded once per module instance; every caller shares the one
 * request, and a caller's abort ends only its own participation.
 *
 * @packageDocumentation
 */

import { type Borders, validateBorders } from './index.js';

const PREFIX = '@latkit/network';

let cached: Borders | null = null;
let inFlight: Promise<Borders> | null = null;

/**
 * Load and validate the packaged border geometry.
 *
 * @remarks
 * Successful work is shared across every caller in this module instance. A rejection is never
 * memoized, so a transient failure retries on the next call. `signal` aborts only this caller's
 * wait: it never cancels the shared fetch or keeps another caller from its result.
 */
export function loadBorders(signal?: AbortSignal): Promise<Borders> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (cached) return Promise.resolve(cached);

  const request = inFlight ?? beginRequest();
  return participate(request, signal);
}

/** Start one shared request and retain only successful decoded data. */
function beginRequest(): Promise<Borders> {
  const request = fetchBorders();
  const tracked: Promise<Borders> = request.then(
    (borders) => {
      cached = borders;
      if (inFlight === tracked) inFlight = null;
      return borders;
    },
    (error: unknown) => {
      if (inFlight === tracked) inFlight = null;
      throw error;
    },
  );
  inFlight = tracked;

  // The shared request may outlive every aborted participant. Observe its rejection here so
  // that a later retry does not leave an unhandled promise.
  void tracked.catch(() => undefined);
  return tracked;
}

/** Fetch both assets concurrently and decode them into the renderer's shape. */
async function fetchBorders(): Promise<Borders> {
  const verticesUrl = new URL('./assets/ne-50m-line-borders.vertices.bin', import.meta.url);
  const indicesUrl = new URL('./assets/ne-50m-line-borders.indices.bin', import.meta.url);
  const [verticesResponse, indicesResponse] = await Promise.all([
    fetch(verticesUrl),
    fetch(indicesUrl),
  ]);

  requireOk(verticesResponse, verticesUrl);
  requireOk(indicesResponse, indicesUrl);

  const [verticesBuffer, indicesBuffer] = await Promise.all([
    verticesResponse.arrayBuffer(),
    indicesResponse.arrayBuffer(),
  ]);
  if (indicesBuffer.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(
      `${PREFIX}: ${indicesUrl.href} byte length must be divisible by ${Uint32Array.BYTES_PER_ELEMENT}`,
    );
  }

  const vertices = new Uint8Array(verticesBuffer);
  const indices = new Uint32Array(indicesBuffer.byteLength / Uint32Array.BYTES_PER_ELEMENT);
  const view = new DataView(indicesBuffer);
  for (let index = 0; index < indices.length; index++) {
    indices[index] = view.getUint32(index * Uint32Array.BYTES_PER_ELEMENT, true);
  }

  const borders: Borders = { vertices, indices };
  validateBorders(borders);
  return borders;
}

/** Reject an unsuccessful asset response before reading either payload. */
function requireOk(response: Response, url: URL): void {
  if (response.ok) return;
  throw new Error(`${PREFIX}: ${url.href} returned HTTP ${response.status}`);
}

/** Race one caller against cancellation without forwarding its signal to fetch. */
function participate(request: Promise<Borders>, signal?: AbortSignal): Promise<Borders> {
  if (!signal) return request;

  return new Promise<Borders>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    request.then(
      (borders) => {
        signal.removeEventListener('abort', abort);
        resolve(borders);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(asError(error, 'border loading failed'));
      },
    );
  });
}

/** Use the platform abort reason while retaining a conventional fallback. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Border load aborted', 'AbortError');
}

function asError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason });
}
