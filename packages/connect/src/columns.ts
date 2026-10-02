import { validateBatch } from '@latkit/model';
import type { Column, DataBatch, SampleColumn, Schema } from '@latkit/model';
import { failure, integer, record, text } from './core.js';
import { align8, checkTree, Op, prepare } from './frame.js';
import type { FrameLimits, Plan } from './frame.js';
import type { EncodedPublication, Limits, Publication } from './types.js';

const arrays = {
  uint8: Uint8Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};
type ArrayType = keyof typeof arrays;
const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
const decoder = new TextDecoder('utf-8', { fatal: true });
function swapped(input: Uint8Array, width: number): Uint8Array {
  const output = Uint8Array.from(input);
  for (let at = 0; at < output.length; at += width)
    for (let j = 0; j < width; j++) output[at + j] = input[at + width - j - 1];
  return output;
}
/** The limits a publication is encoded and decoded under. */
export type PublicationLimits = FrameLimits & Pick<Limits, 'maxPublicationBatches'>;

/** Prepare bounded metadata without copying numeric values. encode() owns the outgoing copy. */
export function preparePublication(
  input: DataBatch | Publication,
  id: number,
  schema: Schema,
  bounds: PublicationLimits,
): Plan {
  const batches = Array.isArray(input) ? input : [input];
  if (!batches.length || batches.length > bounds.maxPublicationBatches)
    throw failure('resource-limit', 'Publication batch count exceeds its bound.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const binary = (value: ArrayBufferView) => {
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
    const offset = align8(size);
    size = offset + value.byteLength;
    if (size > bounds.maxMessageBytes)
      throw failure('resource-limit', 'Publication exceeds the message bound.');
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    chunks.push(littleEndian ? bytes : swapped(bytes, arrays[type].BYTES_PER_ELEMENT));
    return { type, offset, length: value.byteLength / arrays[type].BYTES_PER_ELEMENT };
  };
  function column(value: Column): Record<string, unknown> {
    const common = {
      kind: value.kind,
      offset: value.offset,
      length: value.length,
      ...(value.validity && { validity: binary(value.validity) }),
    };
    switch (value.kind) {
      case 'numeric':
        return {
          ...common,
          values: binary(value.values),
          ...('frameStride' in value
            ? { frameStride: value.frameStride, rowStride: (value as SampleColumn).rowStride }
            : {}),
        };
      case 'boolean':
        return { ...common, values: binary(value.values) };
      case 'reference':
        return { ...common, index: value.index, values: binary(value.values) };
      case 'text':
        return { ...common, bytes: binary(value.bytes), offsets: binary(value.offsets) };
      case 'vector':
        return { ...common, size: value.size, values: column(value.values) };
      case 'list':
        return { ...common, offsets: binary(value.offsets), values: column(value.values) };
    }
  }
  function batch(value: DataBatch) {
    checkTree(value, bounds.maxMetadataBytes, true);
    const issues = validateBatch(schema, value, { maxBlockBytes: bounds.maxMessageBytes });
    if (issues.length) throw failure(issues[0].code, issues[0].message);
    return {
      kind: value.kind,
      index: value.index,
      rows:
        value.rows.kind === 'range'
          ? value.rows
          : { kind: 'indices', values: binary(value.rows.values) },
      ...(value.kind === 'samples'
        ? { firstFrame: value.firstFrame, coordinates: binary(value.coordinates) }
        : value.ids
          ? { ids: column(value.ids) }
          : {}),
      columns: Object.fromEntries(
        Object.entries(value.columns).map(([key, c]) => [key, column(c)]),
      ),
    };
  }
  return prepare(
    Op.publication,
    id,
    { batches: batches.map((value) => batch(value as DataBatch)) },
    chunks,
    bounds,
  );
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
    payload.length > bounds.maxMessageBytes - 16
  )
    throw failure('protocol', 'Invalid publication size.');
  if (payload.byteOffset % 8) payload = Uint8Array.from(payload);
  const header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const metadataBytes = header.getUint32(0, true),
    bodyBytes = header.getUint32(4, true);
  const start = align8(8 + metadataBytes);
  if (metadataBytes > bounds.maxMetadataBytes || start + bodyBytes !== payload.length)
    throw failure('protocol', 'Invalid publication lengths.');
  const metadata = record(JSON.parse(decoder.decode(payload.subarray(8, 8 + metadataBytes))));
  checkTree(metadata, bounds.maxMetadataBytes);
  const body = payload.subarray(start);
  if (
    !Array.isArray(metadata.batches) ||
    !metadata.batches.length ||
    metadata.batches.length > bounds.maxPublicationBatches
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
  return metadata.batches.map((value: unknown) => {
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
    const issues = validateBatch(schema, batch, { maxBlockBytes: bounds.maxMessageBytes });
    if (issues.length) throw failure('protocol', issues[0].message);
    return batch as unknown as DataBatch;
  });
}
