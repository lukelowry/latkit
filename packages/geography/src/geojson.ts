import { createData, type Data } from '@latkit/model';
import { geojsonBatches, type GeoJsonOptions } from './sources/geojson.js';
import { run } from './prepare/client.js';
import { parseJson } from './prepare/jobs.js';

export type { GeoJsonOptions } from './sources/geojson.js';

/**
 * Rows from GeoJSON: a FeatureCollection, a Feature, or a bare geometry, as text or parsed.
 * Polygons give `rings`, lines give `points`, a point gives `position`, and properties become
 * fields. Text parses in a worker, off the page's thread.
 */
export async function geojson(json: string | object, options: GeoJsonOptions = {}): Promise<Data> {
  if (typeof json === 'string' && typeof options.type !== 'function') {
    const { schema, batches } = await run({
      kind: 'geojson',
      text: json,
      options: { ...options, type: options.type as string | undefined },
    });
    return createData(schema, batches);
  }
  const parsed = typeof json === 'string' ? parseJson(json) : json,
    { schema, batches } = geojsonBatches(parsed, options);
  return createData(schema, batches);
}
