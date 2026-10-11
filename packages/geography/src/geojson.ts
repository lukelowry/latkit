import { createData, failure, type Data } from '@latkit/model';
import { geojsonBatches } from './sources/geojson.js';
import type { Geography } from './geography.js';
import { run } from './prepare/client.js';
import { parseJson } from './prepare/jobs.js';

/**
 * Rows from GeoJSON: a FeatureCollection, a Feature, or a bare geometry. Polygons give `rings`,
 * lines give `points`, a point gives `position`, and properties become fields. A URL to fetch, as a
 * string or a URL; a Blob such as a local file; or bytes, gzipped or not, are decoded and parsed in a
 * worker, off the page's thread. An object is already parsed; JSON text in hand reads as
 * `new Blob([text])`.
 */
export async function geojson(
  from: string | URL | Blob | ArrayBuffer | ArrayBufferView | object,
  options: Geography.GeoJsonOptions = {},
): Promise<Data> {
  const { signal, type, id, source } = options;
  signal?.throwIfAborted();
  // Bytes fetched or read here are this call's own, so they move to the worker without a copy.
  let owned: Uint8Array | undefined;
  if (typeof from === 'string' || from instanceof URL) {
    const response = await fetch(from, { signal });
    if (!response.ok) throw failure('io', `GeoJSON could not be read from ${String(from)}`);
    owned = new Uint8Array(await response.arrayBuffer());
  } else if (typeof Blob !== 'undefined' && from instanceof Blob)
    owned = new Uint8Array(await from.arrayBuffer());
  const bytes =
    owned ??
    (from instanceof ArrayBuffer
      ? new Uint8Array(from)
      : ArrayBuffer.isView(from)
        ? new Uint8Array(from.buffer, from.byteOffset, from.byteLength)
        : undefined);
  if (bytes && typeof type !== 'function') {
    const { schema, batches } = await run(
      { kind: 'geojson', bytes, options: { type, id, source } },
      owned ? [owned.buffer as ArrayBuffer] : [],
      signal,
    );
    return createData(schema, batches);
  }
  // A type named per feature by a function parses here, where the function runs.
  const parsed = bytes ? await parseJson(bytes) : from;
  const { schema, batches } = geojsonBatches(parsed, { type, id, source });
  return createData(schema, batches);
}
