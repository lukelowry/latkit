/**
 * One message as one binary frame: a fixed prefix, a JSON header, then every typed array in the
 * message at an 8-byte-aligned offset, so a decoded `Float64Array` views the received buffer in
 * place. The header names the path to each array, so the JSON body holds `null` where an array
 * goes and no placeholder can collide with a value.
 *
 * @remarks
 * Layout: bytes 0-3 are the ASCII magic `LKPF`, byte 4 the format version (1), bytes 5-7 zero,
 * bytes 8-11 the header length as a little-endian `u32`, then the UTF-8 JSON header
 * `{ body, arrays: [{ path, kind, bytes }] }`, then each array at the next 8-byte boundary. JSON
 * carries the body, so JSON values plus typed arrays are the whole value model: `undefined`
 * properties vanish, `NaN` becomes `null`, and any other binary or non-plain object is refused.
 */

const MAGIC = Uint8Array.of(0x4c, 0x4b, 0x50, 0x46); // 'LKPF'
const VERSION = 1;
/** Magic (4), version (1), reserved (3), header length (4). */
const PREFIX = 12;
const ALIGNMENT = 8;

type Kind = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64';
type Path = readonly (string | number)[];
type Typed =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

interface Descriptor {
  readonly path: Path;
  readonly kind: Kind;
  readonly bytes: number;
}

interface Header {
  readonly body: unknown;
  readonly arrays: readonly Descriptor[];
}

interface Lifted {
  readonly path: Path;
  readonly kind: Kind;
  readonly array: Typed;
}

interface View {
  new (buffer: ArrayBuffer, byteOffset: number, length: number): Typed;
  readonly BYTES_PER_ELEMENT: number;
}

const VIEWS: Readonly<Record<Kind, View>> = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

const KINDS: ReadonlyMap<string, Kind> = new Map([
  ['[object Uint8Array]', 'u8'],
  ['[object Int8Array]', 'i8'],
  ['[object Uint16Array]', 'u16'],
  ['[object Int16Array]', 'i16'],
  ['[object Uint32Array]', 'u32'],
  ['[object Int32Array]', 'i32'],
  ['[object Float32Array]', 'f32'],
  ['[object Float64Array]', 'f64'],
]);

/** The type tag, which survives realms where `instanceof` does not. */
function tagOf(value: object): string {
  return Object.prototype.toString.call(value);
}

function align(offset: number): number {
  return Math.ceil(offset / ALIGNMENT) * ALIGNMENT;
}

function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && Object.hasOwn(VIEWS, value);
}

function isPath(value: unknown): value is Path {
  return (
    Array.isArray(value) &&
    (value as unknown[]).every(
      (key) =>
        typeof key === 'string' ||
        (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0),
    )
  );
}

function isDescriptor(value: unknown): value is Descriptor {
  if (typeof value !== 'object' || value === null) return false;
  const { path, kind, bytes } = value as {
    readonly path?: unknown;
    readonly kind?: unknown;
    readonly bytes?: unknown;
  };
  return (
    isPath(path) &&
    isKind(kind) &&
    typeof bytes === 'number' &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0
  );
}

/** Copy `value` with every typed array replaced by null, collecting each array with its path. */
function lift(value: unknown, path: (string | number)[], out: Lifted[]): unknown {
  if (value === null || typeof value !== 'object') return value;
  const tag = tagOf(value);
  const kind = KINDS.get(tag);
  if (kind) {
    out.push({ path: [...path], kind, array: value as Typed });
    return null;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((entry, at) => {
      path.push(at);
      const lifted = lift(entry, path, out);
      path.pop();
      return lifted;
    });
  }
  if (tag !== '[object Object]') throw new Error(`a frame cannot carry ${tag.slice(8, -1)}`);
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    path.push(key);
    copy[key] = lift(record[key], path, out);
    path.pop();
  }
  return copy;
}

/** The child at `key`, which must exist: a number into an array, a string into an object. */
function childOf(container: unknown, key: string | number): unknown {
  if (Array.isArray(container)) {
    if (typeof key === 'number' && key < container.length) return (container as unknown[])[key];
  } else if (
    typeof container === 'object' &&
    container !== null &&
    typeof key === 'string' &&
    Object.hasOwn(container, key)
  ) {
    return (container as Record<string, unknown>)[key];
  }
  throw new Error('frame array path is invalid');
}

/** Put `array` where `path` points in `root`, which holds null there; an empty path is the root. */
function place(root: unknown, path: Path, array: Typed): unknown {
  if (path.length === 0) {
    if (root !== null) throw new Error('frame array path is invalid');
    return array;
  }
  let container = root;
  for (const key of path.slice(0, -1)) container = childOf(container, key);
  const key = path[path.length - 1];
  if (childOf(container, key) !== null) throw new Error('frame array path is invalid');
  // Defined, not assigned: a `__proto__` key must become an own property, never a prototype.
  Object.defineProperty(container as object, key, {
    value: array,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return root;
}

function parseHeader(text: string): Header {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('frame header is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('frame header is malformed');
  const { body, arrays } = parsed as { readonly body?: unknown; readonly arrays?: unknown };
  if (!Array.isArray(arrays)) throw new Error('frame header is malformed');
  const descriptors: Descriptor[] = [];
  for (const entry of arrays as unknown[]) {
    if (!isDescriptor(entry)) throw new Error('frame header is malformed');
    descriptors.push(entry);
  }
  return { body, arrays: descriptors };
}

/**
 * Encode one message as a frame.
 *
 * @throws Error when the message holds binary other than the eight typed-array kinds, or an
 * object that is not a plain object or array.
 */
export function encodeFrame(message: unknown): Uint8Array {
  const lifted: Lifted[] = [];
  const body = lift(message, [], lifted);
  const header: Header = {
    body,
    arrays: lifted.map(({ path, kind, array }) => ({ path, kind, bytes: array.byteLength })),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  let length = align(PREFIX + encoded.byteLength);
  const offsets = lifted.map(({ array }) => {
    const offset = length;
    length = align(offset + array.byteLength);
    return offset;
  });
  const frame = new Uint8Array(length);
  frame.set(MAGIC, 0);
  frame[4] = VERSION;
  new DataView(frame.buffer).setUint32(8, encoded.byteLength, true);
  frame.set(encoded, PREFIX);
  lifted.forEach(({ array }, at) => {
    frame.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offsets[at]);
  });
  return frame;
}

/**
 * Decode a frame produced by `encodeFrame`; typed arrays view `buffer` in place.
 *
 * @throws Error when the buffer is not a frame of this version or disagrees with its own header.
 */
export function decodeFrame(buffer: ArrayBuffer): unknown {
  if (buffer.byteLength < PREFIX) throw new Error('frame is truncated');
  const prefix = new Uint8Array(buffer, 0, PREFIX);
  if (!MAGIC.every((byte, at) => prefix[at] === byte)) {
    throw new Error('frame is not a latkit port frame');
  }
  const version = prefix[4];
  if (version !== VERSION) throw new Error(`frame version ${version} is not supported`);
  const headerBytes = new DataView(buffer).getUint32(8, true);
  if (PREFIX + headerBytes > buffer.byteLength) throw new Error('frame header overruns the frame');
  const header = parseHeader(new TextDecoder().decode(new Uint8Array(buffer, PREFIX, headerBytes)));
  let offset = align(PREFIX + headerBytes);
  let value = header.body;
  for (const { path, kind, bytes } of header.arrays) {
    const Typed = VIEWS[kind];
    if (offset + bytes > buffer.byteLength) throw new Error('frame array overruns the frame');
    if (bytes % Typed.BYTES_PER_ELEMENT !== 0) throw new Error('frame array is not whole elements');
    const array = new Typed(buffer, offset, bytes / Typed.BYTES_PER_ELEMENT);
    offset = align(offset + bytes);
    value = place(value, path, array);
  }
  return value;
}

/**
 * The `ArrayBuffer` a binary payload views, or null for anything non-binary. A view onto a window
 * of a larger buffer is sliced, so frame offsets stay buffer-absolute.
 */
export function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (typeof data !== 'object' || data === null) return null;
  if (tagOf(data) === '[object ArrayBuffer]') return data as ArrayBuffer;
  if (ArrayBuffer.isView(data)) {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? (data.buffer as ArrayBuffer)
      : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  }
  return null;
}
