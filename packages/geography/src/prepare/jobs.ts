import { failure, type Column, type Schema, type Data } from '@latkit/model';
import { geojsonBatches } from '../sources/geojson.js';
import type { Geography } from '../geography.js';
import { decodeVector, type VectorRequest, type VectorTile } from '../sources/vector.js';
import { prepareShapes, shapesBuffers, type Shapes, type ShapesInput } from './shapes.js';
import { ungzipped } from '../sources/bytes.js';

/** Work the geography hands to a worker: shapes to prepare, a vector tile, or GeoJSON's bytes, gzipped or not. */
export type Job =
  | { readonly kind: 'shapes'; readonly input: ShapesInput }
  | { readonly kind: 'vector'; readonly request: VectorRequest }
  | {
      readonly kind: 'geojson';
      readonly bytes: Uint8Array;
      readonly options: Pick<Geography.GeoJsonOptions, 'id' | 'source'> & {
        readonly type?: string;
      };
    };
/** What each job returns. */
export interface JobResults {
  readonly shapes: Shapes;
  readonly vector: VectorTile;
  readonly geojson: { readonly schema: Schema; readonly batches: readonly Data.RowBatch[] };
}

/** GeoJSON's bytes, gzipped or not, parsed. */
export async function parseJson(bytes: Uint8Array): Promise<unknown> {
  const text = new TextDecoder().decode(await ungzipped(bytes));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw failure('invalid-input', 'Not GeoJSON: the text is not JSON.', { cause: error });
  }
}
/** The buffers a column holds, to transfer it whole. */
function columnBuffers(column: Column | undefined, out: Set<ArrayBuffer>): void {
  if (!column) return;
  if (column.validity) out.add(column.validity.buffer as ArrayBuffer);
  if (column.kind === 'text') {
    out.add(column.bytes.buffer as ArrayBuffer);
    out.add(column.offsets.buffer as ArrayBuffer);
  } else if (column.kind === 'list') {
    out.add(column.offsets.buffer as ArrayBuffer);
    columnBuffers(column.values, out);
  } else if (column.kind === 'vector') columnBuffers(column.values, out);
  else out.add(column.values.buffer as ArrayBuffer);
}
function batchBuffers(batches: readonly Data.RowBatch[], out: Set<ArrayBuffer>): void {
  for (const batch of batches) {
    columnBuffers(batch.ids, out);
    for (const column of Object.values(batch.columns ?? {})) columnBuffers(column, out);
    if (batch.rows.kind === 'indices') out.add(batch.rows.values.buffer as ArrayBuffer);
  }
}

/** Run a job, returning its result and the buffers to transfer with it. */
export async function runJob(
  job: Job,
): Promise<{ readonly result: unknown; readonly transfer: ArrayBuffer[] }> {
  if (job.kind === 'shapes') {
    const shapes = prepareShapes(job.input);
    return { result: shapes, transfer: shapesBuffers(shapes) };
  }
  if (job.kind === 'vector') {
    const { tile, transfer } = decodeVector(job.request),
      buffers = new Set(transfer);
    batchBuffers(tile.batches, buffers);
    return { result: tile, transfer: [...buffers] };
  }
  const result = geojsonBatches(await parseJson(job.bytes), job.options),
    buffers = new Set<ArrayBuffer>();
  batchBuffers(result.batches, buffers);
  return { result, transfer: [...buffers] };
}
