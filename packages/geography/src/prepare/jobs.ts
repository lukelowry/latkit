import { failure, type Column, type Schema, type Data } from '@latkit/model';
import { geojsonBatches } from '../sources/geojson.js';
import type { Geography } from '../geography.js';
import { decodeVector, type VectorRequest, type VectorTile } from '../sources/vector.js';
import { prepareShapes, shapesBuffers, type Shapes, type ShapesInput } from './shapes.js';

/** Work the geography hands to a worker: shapes to prepare, a vector tile, or GeoJSON as text or bytes. */
export type Job =
  | { readonly kind: 'shapes'; readonly input: ShapesInput }
  | { readonly kind: 'vector'; readonly request: VectorRequest }
  | {
      readonly kind: 'geojson';
      readonly text?: string;
      readonly bytes?: Uint8Array;
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

/** GeoJSON text, parsed. */
export function parseJson(text: string): unknown {
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
export function runJob(job: Job): { readonly result: unknown; readonly transfer: ArrayBuffer[] } {
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
  const text = job.text ?? new TextDecoder().decode(job.bytes),
    result = geojsonBatches(parseJson(text), job.options),
    buffers = new Set<ArrayBuffer>();
  batchBuffers(result.batches, buffers);
  return { result, transfer: [...buffers] };
}
