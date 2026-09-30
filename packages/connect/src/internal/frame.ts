import { failure } from './errors.js';
type Typed =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;
const types = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
};
type Kind = keyof typeof types;
type Path = (string | number)[];
interface View {
  path: Path;
  kind: Kind;
  segment: number;
  offset: number;
  length: number;
}
interface Segment {
  buffer: ArrayBufferLike;
  start: number;
  end: number;
  origin: number;
}
export interface Limits {
  maxMetadataBytes: number;
  maxInFlightBytes: number;
  maxStreams: number;
  maxReferences: number;
}
export const defaults: Limits = {
  maxMetadataBytes: 1024 * 1024,
  maxInFlightBytes: 16 * 1024 * 1024,
  maxStreams: 128,
  maxReferences: 2048,
};
export function limits(input: Partial<Limits> = {}): Limits {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(defaults, key))
  )
    throw failure('invalid-input', 'Unknown connection limit.');
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result))
    if (!Number.isSafeInteger(value) || value < 1)
      throw failure('invalid-input', 'Invalid limit: ' + key);
  if (result.maxInFlightBytes < 1024 || result.maxMetadataBytes > result.maxInFlightBytes)
    throw failure('invalid-input', 'Metadata must fit the connection byte bound (at least 1024).');
  return result;
}
const align = (value: number): number => Math.ceil(value / 8) * 8;
/** Separate binary paths avoid magic placeholder collisions in domain values. */
function lift(
  value: unknown,
  path: Path,
  views: { path: Path; kind: Kind; array: Typed }[],
  seen: Set<object>,
  depth: number,
): unknown {
  if (depth > 64) throw failure('resource-limit', 'Wire nesting exceeds 64.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('invalid-input', 'Nonfinite metadata.');
    return value;
  }
  if (typeof value !== 'object') throw failure('invalid-input', 'Nonportable wire value.');
  if (ArrayBuffer.isView(value)) {
    const kind = Object.prototype.toString.call(value).slice(8, -1) as Kind;
    if (!Object.hasOwn(types, kind)) throw failure('invalid-input', 'Unsupported binary view.');
    views.push({ path, kind, array: value as Typed });
    return null;
  }
  if (seen.has(value)) throw failure('invalid-input', 'Cyclic wire value.');
  seen.add(value);
  let copy: unknown;
  if (Array.isArray(value))
    copy = value.map((item, i) => lift(item, [...path, i], views, seen, depth + 1));
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw failure('invalid-input', 'Expected plain wire object.');
    const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) object[key] = lift(item, [...path, key], views, seen, depth + 1);
    copy = object;
  }
  seen.delete(value);
  return copy;
}
export function inspect(
  value: unknown,
  bounds: Limits,
): { body: unknown; views: View[]; segments: Segment[]; header: Uint8Array; bytes: number } {
  const arrays: { path: Path; kind: Kind; array: Typed }[] = [];
  const body = lift(value, [], arrays, new Set(), 0);
  const groups = new Map<ArrayBufferLike, { start: number; end: number }[]>();
  for (const { array } of arrays) {
    const ranges = groups.get(array.buffer) ?? [];
    ranges.push({ start: array.byteOffset, end: array.byteOffset + array.byteLength });
    groups.set(array.buffer, ranges);
  }
  const segments: Segment[] = [];
  for (const [buffer, ranges] of groups) {
    ranges.sort((a, b) => a.start - b.start);
    let current: Segment | undefined;
    for (const range of ranges) {
      if (current && range.start <= current.end) current.end = Math.max(current.end, range.end);
      else {
        current = { buffer, ...range, origin: Math.floor(range.start / 8) * 8 };
        segments.push(current);
      }
    }
  }
  const views = arrays.map(({ array, kind, path }) => {
    const segment = segments.findIndex(
      (s) =>
        s.buffer === array.buffer &&
        s.start <= array.byteOffset &&
        s.end >= array.byteOffset + array.byteLength,
    );
    return {
      path,
      kind,
      segment,
      offset: array.byteOffset - segments[segment].origin,
      length: array.length,
    };
  });
  const header = new TextEncoder().encode(
    JSON.stringify({ body, views, segments: segments.map((s) => s.end - s.origin) }),
  );
  if (header.byteLength > bounds.maxMetadataBytes)
    throw failure('resource-limit', 'Metadata exceeds connection limit.');
  const bytes =
    align(8 + header.byteLength) + segments.reduce((n, s) => n + align(s.end - s.origin), 0);
  if (bytes > bounds.maxInFlightBytes)
    throw failure('resource-limit', 'Message exceeds connection byte limit.');
  return { body, views, segments, header, bytes };
}
export function encodeFrame(value: unknown, bounds: Limits): Uint8Array {
  const plan = inspect(value, bounds);
  const frame = new Uint8Array(plan.bytes);
  frame.set([76, 75, 67, 49]);
  new DataView(frame.buffer).setUint32(4, plan.header.byteLength, true);
  frame.set(plan.header, 8);
  let offset = align(8 + plan.header.byteLength);
  for (const segment of plan.segments) {
    frame.set(
      new Uint8Array(segment.buffer, segment.start, segment.end - segment.start),
      offset + segment.start - segment.origin,
    );
    offset += align(segment.end - segment.origin);
  }
  return frame;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('invalid-input', 'Invalid frame metadata.');
  return value as Record<string, unknown>;
}
export function decodeFrame(data: ArrayBuffer | Uint8Array, bounds: Limits): unknown {
  let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > bounds.maxInFlightBytes)
    throw failure('resource-limit', 'Frame exceeds connection limit.');
  if (bytes.byteOffset % 8 !== 0 || !(bytes.buffer instanceof ArrayBuffer)) bytes = bytes.slice();
  if (bytes.length < 8 || ![76, 75, 67, 49].every((v, i) => bytes[i] === v))
    throw failure('invalid-input', 'Invalid connect frame.');
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (size > bounds.maxMetadataBytes || 8 + size > bytes.length)
    throw failure('resource-limit', 'Invalid frame metadata size.');
  const header = object(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + size)),
    ) as unknown,
  );
  if (!Array.isArray(header.views) || !Array.isArray(header.segments))
    throw failure('invalid-input', 'Invalid frame descriptors.');
  const offsets: number[] = [];
  let end = align(8 + size);
  for (const size of header.segments as unknown[]) {
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + size > bytes.length
    )
      throw failure('invalid-input', 'Invalid binary segment.');
    offsets.push(end);
    end += align(size);
  }
  if (end !== bytes.length) throw failure('invalid-input', 'Truncated or trailing frame bytes.');
  let body = header.body;
  const placed = new Set<string>();
  for (const item of header.views as unknown[]) {
    const view = object(item);
    const path = view.path;
    if (
      !Array.isArray(path) ||
      path.length > 64 ||
      !path.every((p) => typeof p === 'string' || (Number.isSafeInteger(p) && Number(p) >= 0)) ||
      typeof view.kind !== 'string' ||
      !Object.hasOwn(types, view.kind)
    )
      throw failure('invalid-input', 'Invalid binary descriptor.');
    const key = JSON.stringify(path);
    if (placed.has(key)) throw failure('invalid-input', 'Duplicate binary path.');
    placed.add(key);
    const { segment, offset, length } = view;
    if (
      typeof segment !== 'number' ||
      !Number.isSafeInteger(segment) ||
      segment < 0 ||
      segment >= offsets.length ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      throw failure('invalid-input', 'Invalid binary slice.');
    const Type = types[view.kind as Kind];
    if (
      offset % Type.BYTES_PER_ELEMENT ||
      offset + length * Type.BYTES_PER_ELEMENT > (header.segments as number[])[segment]
    )
      throw failure('invalid-input', 'Binary view exceeds segment.');
    const array = new Type(
      bytes.buffer as ArrayBuffer,
      bytes.byteOffset + offsets[segment] + offset,
      length,
    );
    if (!path.length) {
      if (body !== null) throw failure('invalid-input');
      body = array;
      continue;
    }
    let parent: unknown = body;
    for (const part of path.slice(0, -1) as (string | number)[]) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part))
        throw failure('invalid-input', 'Invalid binary path.');
      parent = (parent as Record<string, unknown>)[part];
    }
    const last = path[path.length - 1] as string | number;
    if (
      !parent ||
      typeof parent !== 'object' ||
      !Object.hasOwn(parent, last) ||
      (parent as Record<string, unknown>)[last] !== null
    )
      throw failure('invalid-input', 'Invalid binary slot.');
    Object.defineProperty(parent, last, {
      value: array,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  // Validate metadata depth and portable numbers on both transport paths.
  inspect(body, bounds);
  return body;
}
/** Compact unowned views before transfer; preserve overlapping aliases, omit unexposed bytes. */
export function transferable(
  value: unknown,
  bounds: Limits,
): { value: unknown; buffers: ArrayBuffer[] } {
  const plan = inspect(value, bounds);
  const buffers = plan.segments.map((s) => {
    const buffer = new ArrayBuffer(s.end - s.origin);
    new Uint8Array(buffer).set(
      new Uint8Array(s.buffer, s.start, s.end - s.start),
      s.start - s.origin,
    );
    return buffer;
  });
  let body = plan.body;
  for (const view of plan.views) {
    const Type = types[view.kind];
    const array = new Type(buffers[view.segment], view.offset, view.length);
    if (!view.path.length) {
      body = array;
      continue;
    }
    let parent = body as Record<string, unknown>;
    for (const key of view.path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    Object.defineProperty(parent, view.path.at(-1)!, {
      value: array,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { value: body, buffers };
}
export function backing(value: unknown, bounds: Limits): ArrayBuffer[] {
  const plan = inspect(value, bounds);
  const buffers = [...new Set(plan.segments.map((s) => s.buffer))];
  if (buffers.some((b) => !(b instanceof ArrayBuffer)))
    throw failure('invalid-input', 'Owned buffers cannot be shared.');
  if (buffers.reduce((n, b) => n + b.byteLength, 0) > bounds.maxInFlightBytes)
    throw failure('resource-limit', 'Owned backing exceeds connection limit.');
  return buffers as ArrayBuffer[];
}
