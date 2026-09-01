/**
 * The container under every pack: a 16-byte preamble, a JSON directory, then 8-byte-aligned typed
 * sections. Decoding validates the whole directory before exposing any view, and every section is
 * a zero-copy view into the received buffer.
 *
 * Layout: `LKM\0` · u16 version · u16 flags (0) · u32 directory bytes · u32 payload bytes ·
 * directory · padding · sections.
 */

const MAGIC = Uint8Array.of(0x4c, 0x4b, 0x4d, 0x00);
const VERSION = 1;
const PREAMBLE = 16;
const MAX_DIRECTORY = 64 * 1024 * 1024;
const ALIGN = 8;

/** Typed arrays a section may hold. */
export type Section = Uint8Array | Uint32Array | Float32Array | Float64Array;

type Scalar = 'u8' | 'u32' | 'f32' | 'f64';

interface Entry {
  readonly id: string;
  readonly type: Scalar;
  readonly offset: number;
  readonly count: number;
}

const BYTES: Record<Scalar, number> = { u8: 1, u32: 4, f32: 4, f64: 8 };

function align(value: number): number {
  return Math.ceil(value / ALIGN) * ALIGN;
}

function scalarOf(data: Section): Scalar {
  const tag = Object.prototype.toString.call(data);
  switch (tag) {
    case '[object Uint8Array]':
      return 'u8';
    case '[object Uint32Array]':
      return 'u32';
    case '[object Float32Array]':
      return 'f32';
    case '[object Float64Array]':
      return 'f64';
    default:
      throw new Error('unsupported section array');
  }
}

/** Encode a directory and its sections into one buffer. */
export function encode<M>(
  kind: string,
  meta: M,
  sections: readonly { readonly id: string; readonly data: Section }[],
): Uint8Array {
  const ids = new Set<string>();
  let payload = 0;
  const entries = sections.map(({ id, data }): Entry => {
    if (ids.has(id)) throw new Error(`duplicate section '${id}'`);
    ids.add(id);
    const offset = align(payload);
    payload = offset + data.byteLength;
    return { id, type: scalarOf(data), offset, count: data.length };
  });
  const directory = new TextEncoder().encode(JSON.stringify({ kind, meta, sections: entries }));
  if (directory.byteLength > MAX_DIRECTORY) throw new Error('pack directory too large');
  const payloadOffset = align(PREAMBLE + directory.byteLength);
  const out = new Uint8Array(payloadOffset + payload);
  out.set(MAGIC);
  const view = new DataView(out.buffer);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, directory.byteLength, true);
  view.setUint32(12, payload, true);
  out.set(directory, PREAMBLE);
  sections.forEach(({ data }, index) => {
    out.set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      payloadOffset + entries[index]!.offset,
    );
  });
  return out;
}

/** A validated directory plus zero-copy section access. */
export interface Decoded<M> {
  readonly meta: M;
  /** The section by id, as the typed array it was encoded from. */
  section(id: string): Section;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a pack of `kind` completely, then expose its directory and sections.
 *
 * @throws Error on any structural inconsistency.
 */
export function decode<M>(source: Uint8Array, kind: string): Decoded<M> {
  if (source.byteLength < PREAMBLE) throw new Error('truncated pack');
  let bytes = source;
  if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset % ALIGN !== 0)
    bytes = bytes.slice();
  const buffer = bytes.buffer as ArrayBuffer;
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC[index]) throw new Error('not a pack');
  }
  const view = new DataView(buffer, bytes.byteOffset, PREAMBLE);
  if (view.getUint16(4, true) !== VERSION) throw new Error('unsupported pack version');
  if (view.getUint16(6, true) !== 0) throw new Error('unsupported pack flags');
  const directoryBytes = view.getUint32(8, true);
  const payloadBytes = view.getUint32(12, true);
  if (directoryBytes === 0 || directoryBytes > MAX_DIRECTORY)
    throw new Error('invalid pack directory');
  const payloadOffset = align(PREAMBLE + directoryBytes);
  if (payloadOffset + payloadBytes !== bytes.byteLength)
    throw new Error('inconsistent pack length');

  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(PREAMBLE, PREAMBLE + directoryBytes),
    ),
  );
  if (!isRecord(parsed) || parsed['kind'] !== kind) throw new Error(`expected a ${kind} pack`);
  if (!Array.isArray(parsed['sections'])) throw new Error('pack sections must be an array');
  const entries = new Map<string, Entry>();
  let end = 0;
  for (const item of parsed['sections'] as unknown[]) {
    if (!isRecord(item)) throw new Error('invalid pack section');
    const { id, type, offset, count } = item;
    if (typeof id !== 'string' || entries.has(id)) throw new Error('invalid pack section id');
    if (type !== 'u8' && type !== 'u32' && type !== 'f32' && type !== 'f64') {
      throw new Error(`section '${id}' has an unsupported type`);
    }
    if (
      typeof offset !== 'number' ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(count) ||
      offset < end ||
      offset % ALIGN !== 0 ||
      offset + count * BYTES[type] > payloadBytes
    ) {
      throw new Error(`section '${id}' overlaps or exceeds the payload`);
    }
    entries.set(id, { id, type, offset, count });
    end = offset + count * BYTES[type];
  }
  const base = bytes.byteOffset + payloadOffset;
  return {
    meta: parsed['meta'] as M,
    section(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`missing section '${id}'`);
      const offset = base + entry.offset;
      switch (entry.type) {
        case 'u8':
          return new Uint8Array(buffer, offset, entry.count);
        case 'u32':
          return new Uint32Array(buffer, offset, entry.count);
        case 'f32':
          return new Float32Array(buffer, offset, entry.count);
        case 'f64':
          return new Float64Array(buffer, offset, entry.count);
      }
    },
  };
}

/** The section by id, checked to be the expected array type. */
export function typed<T extends Section>(
  pack: Decoded<unknown>,
  id: string,
  ctor: new (buffer: ArrayBuffer, byteOffset: number, length: number) => T,
): T {
  const section = pack.section(id);
  if (!(section instanceof ctor)) throw new Error(`section '${id}' has the wrong type`);
  return section;
}
