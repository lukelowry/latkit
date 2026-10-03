import { failure, rowCount, sliceSamples, validateBatch } from '@latkit/model';
import type {
  Column,
  DataBatch,
  Publication,
  SampleBatch,
  SampleColumn,
  Schema,
} from '@latkit/model';
import { integer, record, text } from './core.js';
import { align8, checkTree, forward, HEADER, Op, prepare } from './frame.js';
import type { FrameLimits, Plan } from './frame.js';
import type { ConnectLimits, EncodedPublication } from './types.js';

const arrays = {
  uint8: Uint8Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};
type ArrayType = keyof typeof arrays;
const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function swapped(input: Uint8Array, width: number): Uint8Array {
  const output = Uint8Array.from(input);
  for (let at = 0; at < output.length; at += width)
    for (let j = 0; j < width; j++) output[at + j] = input[at + width - j - 1];
  return output;
}
/** The limits a publication is encoded and decoded under. */
export type PublicationLimits = FrameLimits & Pick<ConnectLimits, 'publicationBatches'>;

/** The payload each publication decodePublication made arrived as. Its batches view the same
 *  storage, so remembering it costs nothing. */
const arrived = new WeakMap<Publication, Uint8Array>();

/** The messages that carry `input` on stream `id`: a publication connect received goes on as it
 *  arrived when it fits `bounds`, validated once already; anything else in the fewest new messages. */
export function publicationPlans(
  input: DataBatch | Publication,
  id: number,
  schema: Schema,
  bounds: PublicationLimits,
): Iterable<Plan> {
  const payload = Array.isArray(input) ? arrived.get(input as Publication) : undefined;
  if (
    payload &&
    16 + payload.byteLength <= bounds.messageBytes &&
    new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true) <=
      bounds.metadataBytes &&
    (input as Publication).length <= bounds.publicationBatches
  )
    return [forward(id, payload)];
  return preparePublications(input, id, schema, bounds);
}

/** One atomic publication message; throws when `input` does not fit the bounds. Prepares bounded
 *  metadata without copying numeric values: encode() owns the outgoing copy. */
export function preparePublication(
  input: DataBatch | Publication,
  id: number,
  schema: Schema,
  bounds: PublicationLimits,
): Plan {
  const frame = new PublicationFrame(bounds);
  for (const batch of batchesOf(input)) {
    validate(batch, schema, bounds);
    if (!frame.add(batch))
      throw failure('resource-limit', 'Publication exceeds its message bounds.');
  }
  return frame.plan(id);
}

/** The fewest publication messages for `input`, in order. A group that fits is one atomic message;
 *  a sample batch beyond one message is cut between whole frames, so each piece appends in turn. */
export function* preparePublications(
  input: DataBatch | Publication,
  id: number,
  schema: Schema,
  bounds: PublicationLimits,
): Generator<Plan> {
  let frame = new PublicationFrame(bounds);
  for (const batch of batchesOf(input)) {
    validate(batch, schema, bounds);
    for (const piece of batch.kind === 'samples' ? framesOf(batch, bounds) : [batch]) {
      if (frame.add(piece)) continue;
      if (frame.size) {
        yield frame.plan(id);
        frame = new PublicationFrame(bounds);
        if (frame.add(piece)) continue;
      }
      throw failure(
        'resource-limit',
        batch.kind === 'samples'
          ? 'One sample frame exceeds the message bounds.'
          : 'A row batch exceeds the message bounds.',
      );
    }
  }
  yield frame.plan(id);
}

/** UTF-8 bytes of the metadata of a publication without batches. */
const EMPTY = JSON.stringify({ batches: [] }).length;

/** Batches laid into one publication frame in order, each batch's binary placed as it is added. */
class PublicationFrame {
  private readonly chunks: Uint8Array[] = [];
  private readonly batches: Record<string, unknown>[] = [];
  private body = 0;
  private json = EMPTY;
  constructor(private readonly bounds: PublicationLimits) {}

  get size(): number {
    return this.batches.length;
  }

  /** Adds a validated batch, or returns false and leaves the frame unchanged when a bound would be exceeded. */
  add(batch: DataBatch): boolean {
    if (this.batches.length === this.bounds.publicationBatches) return false;
    const chunks = this.chunks.length,
      body = this.body;
    const metadata = describe(batch, (view) => this.place(view));
    const json =
      this.json + encoder.encode(JSON.stringify(metadata)).length + (this.batches.length ? 1 : 0);
    if (
      json > this.bounds.metadataBytes ||
      align8(HEADER + json) + this.body > this.bounds.messageBytes
    ) {
      this.chunks.length = chunks;
      this.body = body;
      return false;
    }
    this.batches.push(metadata);
    this.json = json;
    return true;
  }

  plan(id: number): Plan {
    return prepare(Op.publication, id, { batches: this.batches }, this.chunks, this.bounds);
  }

  /** Borrows the view's little-endian bytes at the next aligned body offset. */
  private place(value: ArrayBufferView) {
    const type: ArrayType =
      value instanceof Float64Array
        ? 'float64'
        : value instanceof Float32Array
          ? 'float32'
          : value instanceof Int32Array
            ? 'int32'
            : value instanceof Uint32Array
              ? 'uint32'
              : 'uint8';
    const offset = align8(this.body);
    this.body = offset + value.byteLength;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.chunks.push(littleEndian ? bytes : swapped(bytes, arrays[type].BYTES_PER_ELEMENT));
    return { type, offset, length: value.byteLength / arrays[type].BYTES_PER_ELEMENT };
  }
}

/** A batch's publication metadata, each binary leaf placed by `place`. */
function describe(
  value: DataBatch,
  place: (view: ArrayBufferView) => unknown,
): Record<string, unknown> {
  function column(value: Column): Record<string, unknown> {
    const common = {
      kind: value.kind,
      offset: value.offset,
      length: value.length,
      ...(value.validity && { validity: place(value.validity) }),
    };
    switch (value.kind) {
      case 'numeric':
        return {
          ...common,
          values: place(value.values),
          ...('frameStride' in value
            ? { frameStride: value.frameStride, rowStride: (value as SampleColumn).rowStride }
            : {}),
        };
      case 'boolean':
        return { ...common, values: place(value.values) };
      case 'reference':
        return { ...common, index: value.index, values: place(value.values) };
      case 'text':
        return { ...common, bytes: place(value.bytes), offsets: place(value.offsets) };
      case 'vector':
        return { ...common, size: value.size, values: column(value.values) };
      case 'list':
        return { ...common, offsets: place(value.offsets), values: column(value.values) };
    }
  }
  return {
    kind: value.kind,
    index: value.index,
    rows:
      value.rows.kind === 'range'
        ? value.rows
        : { kind: 'indices', values: place(value.rows.values) },
    ...(value.kind === 'samples'
      ? { firstFrame: value.firstFrame, coordinates: place(value.coordinates) }
      : value.ids
        ? { ids: column(value.ids) }
        : {}),
    columns: Object.fromEntries(Object.entries(value.columns).map(([key, c]) => [key, column(c)])),
  };
}

/** Plain metadata and a layout valid for `schema`. A frame bounds the message size. */
function validate(batch: DataBatch, schema: Schema, bounds: PublicationLimits): void {
  checkTree(batch, bounds.metadataBytes, true);
  const issues = validateBatch(schema, batch);
  if (issues.length) throw failure('invalid-input', issues[0].message, { issues });
}

/** Whole-frame pieces of `batch`, each within an empty message's binary budget. Frame-major
 *  columns split as views; other layouts must fit one message whole. */
function* framesOf(batch: SampleBatch, bounds: PublicationLimits): Generator<SampleBatch> {
  const budget = bounds.messageBytes - align8(HEADER + bounds.metadataBytes);
  if (bodyOf(batch).bytes <= budget) {
    yield batch;
    return;
  }
  const rows = rowCount(batch.rows),
    frames = batch.coordinates.length;
  const piece = (from: number, count: number): SampleBatch => ({
    ...batch,
    firstFrame: batch.firstFrame + from,
    coordinates: batch.coordinates.subarray(from, from + count),
    columns: Object.fromEntries(
      Object.entries(batch.columns).map(([name, column]) => [
        name,
        sliceSamples(column, 0, rows, from, count),
      ]),
    ),
  });
  const fixed = bodyOf(piece(0, 0)),
    one = bodyOf(piece(0, 1));
  // Each view pads to 8 bytes at most once, whatever the frame count.
  const per = Math.max(
    1,
    Math.floor((budget - fixed.bytes - 8 * one.views) / (one.bytes - fixed.bytes)),
  );
  for (let from = 0; from < frames; from += per) yield piece(from, Math.min(per, frames - from));
}

/** Binary bytes and views of a batch exactly as a frame places them. */
function bodyOf(batch: DataBatch): { readonly bytes: number; readonly views: number } {
  let bytes = 0,
    views = 0;
  describe(batch, (view) => {
    bytes = align8(bytes) + view.byteLength;
    views++;
    return null;
  });
  return { bytes, views };
}

function batchesOf(input: DataBatch | Publication): readonly DataBatch[] {
  const batches = Array.isArray(input) ? input : [input];
  if (!batches.length)
    throw failure('resource-limit', 'Publication batch count exceeds its bound.');
  return batches as readonly DataBatch[];
}

/** A connection-independent payload. Received storage is immutable and survives disconnect. */
export function decodePublication(
  publication: EncodedPublication,
  schema: Schema,
  bounds: PublicationLimits,
): Publication {
  let payload = publication.bytes;
  if (
    !(payload.buffer instanceof ArrayBuffer) ||
    payload.length < 8 ||
    payload.length > bounds.messageBytes - 16
  )
    throw failure('protocol', 'Invalid publication size.');
  if (payload.byteOffset % 8) payload = Uint8Array.from(payload);
  const header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const metadataBytes = header.getUint32(0, true),
    bodyBytes = header.getUint32(4, true);
  const start = align8(8 + metadataBytes);
  if (metadataBytes > bounds.metadataBytes || start + bodyBytes !== payload.length)
    throw failure('protocol', 'Invalid publication lengths.');
  const metadata = record(JSON.parse(decoder.decode(payload.subarray(8, 8 + metadataBytes))));
  checkTree(metadata, bounds.metadataBytes);
  const body = payload.subarray(start);
  if (
    !Array.isArray(metadata.batches) ||
    !metadata.batches.length ||
    metadata.batches.length > bounds.publicationBatches
  )
    throw failure('protocol', 'Invalid publication batch count.');
  let referencedBytes = 0;
  function binary(value: unknown, expected?: ArrayType): ArrayBufferView {
    const descriptor = record(value),
      type = text(descriptor.type) as ArrayType;
    if (!Object.hasOwn(arrays, type) || (expected && type !== expected))
      throw failure('protocol', 'Invalid binary type.');
    const ctor = arrays[type],
      offset = integer(descriptor.offset),
      length = integer(descriptor.length);
    if (offset % 8 || length > Math.floor((body.length - offset) / ctor.BYTES_PER_ELEMENT))
      throw failure('protocol', 'Invalid binary range.');
    referencedBytes += length * ctor.BYTES_PER_ELEMENT;
    if (referencedBytes > body.length)
      throw failure('protocol', 'Binary descriptors exceed the body budget.');
    const absolute = body.byteOffset + offset;
    if (!littleEndian) {
      const bytes = swapped(
        new Uint8Array(body.buffer, absolute, length * ctor.BYTES_PER_ELEMENT),
        ctor.BYTES_PER_ELEMENT,
      );
      return new ctor(bytes.buffer as ArrayBuffer, bytes.byteOffset, length);
    }
    return new ctor(body.buffer as ArrayBuffer, absolute, length);
  }
  function column(value: unknown, depth = 0): Record<string, unknown> {
    if (depth > 24) throw failure('resource-limit', 'Column nesting limit exceeded.');
    const c = record(value),
      kind = text(c.kind);
    const common = {
      kind,
      offset: integer(c.offset),
      length: integer(c.length),
      ...(c.validity !== undefined && { validity: binary(c.validity, 'uint8') }),
    };
    switch (kind) {
      case 'numeric':
        return {
          ...common,
          values: binary(c.values),
          ...(c.frameStride !== undefined && {
            frameStride: integer(c.frameStride),
            rowStride: integer(c.rowStride),
          }),
        };
      case 'boolean':
        return { ...common, values: binary(c.values, 'uint8') };
      case 'reference':
        return { ...common, index: c.index, values: binary(c.values, 'uint32') };
      case 'text':
        return { ...common, bytes: binary(c.bytes, 'uint8'), offsets: binary(c.offsets, 'int32') };
      case 'vector':
        return { ...common, size: integer(c.size, 1), values: column(c.values, depth + 1) };
      case 'list':
        return {
          ...common,
          offsets: binary(c.offsets, 'int32'),
          values: column(c.values, depth + 1),
        };
      default:
        throw failure('protocol', 'Unknown column kind.');
    }
  }
  const decoded: Publication = metadata.batches.map((value: unknown) => {
    const m = record(value),
      rows = record(m.rows);
    if (
      !['rows', 'samples'].includes(String(m.kind)) ||
      !['range', 'indices'].includes(String(rows.kind))
    )
      throw failure('protocol', 'Unknown batch or row kind.');
    const batch = {
      kind: m.kind,
      index: m.index,
      rows:
        rows.kind === 'range' ? rows : { kind: 'indices', values: binary(rows.values, 'uint32') },
      ...(m.kind === 'samples'
        ? { firstFrame: integer(m.firstFrame), coordinates: binary(m.coordinates, 'float64') }
        : m.ids !== undefined
          ? { ids: column(m.ids) }
          : {}),
      columns: Object.fromEntries(
        Object.entries(record(m.columns)).map(([key, c]) => [key, column(c)]),
      ),
    };
    const issues = validateBatch(schema, batch, { maxBlockBytes: bounds.messageBytes });
    if (issues.length) throw failure('protocol', issues[0].message);
    return batch as unknown as DataBatch;
  });
  arrived.set(decoded, payload);
  return decoded;
}
