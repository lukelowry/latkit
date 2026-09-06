/** Shared decoding for the JSON the elements accept: numeric slots, records, and paths. */

const PREFIX = '@latkit/embed';
const U32_MAX = 0xffff_ffff;

/** Numeric JSON array, `null` standing for NaN, or little-endian bytes as base64. */
export type NumericJSON = readonly (number | null)[] | { readonly base64: string };

/** Decode an f32 slot without relying on host endianness. */
export function f32(input: unknown, path: string): Float32Array {
  if (Array.isArray(input)) {
    const values = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) values[i] = real(input[i], `${path}[${i}]`);
    return values;
  }
  const view = base64(input, path, 4);
  const values = new Float32Array(view.byteLength / 4);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
  return values;
}

/** Decode an f64 slot without relying on host endianness. */
export function f64(input: unknown, path: string): Float64Array {
  if (Array.isArray(input)) {
    const values = new Float64Array(input.length);
    for (let i = 0; i < input.length; i++) values[i] = real(input[i], `${path}[${i}]`);
    return values;
  }
  const view = base64(input, path, 8);
  const values = new Float64Array(view.byteLength / 8);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat64(i * 8, true);
  return values;
}

/** Decode a u32 slot after validating JSON integers before coercion. */
export function u32(input: unknown, path: string): Uint32Array {
  if (Array.isArray(input)) {
    const values = new Uint32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const value = integer(input[i], `${path}[${i}]`);
      if (value < 0 || value > U32_MAX) fail(`${path}[${i}]`, 'is outside the u32 range');
      values[i] = value;
    }
    return values;
  }
  const view = base64(input, path, 4);
  const values = new Uint32Array(view.byteLength / 4);
  for (let i = 0; i < values.length; i++) values[i] = view.getUint32(i * 4, true);
  return values;
}

/** Decode one base64 object into a view over owned bytes, whole `stride`-byte words only. */
function base64(input: unknown, path: string, stride: number): DataView {
  const source = record(input, path);
  const encoded = string(required(source, 'base64', path), `${path}.base64`);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (cause) {
    throw new Error(`${PREFIX}: ${path}.base64 is invalid`, { cause });
  }
  if (binary.length % stride !== 0) {
    fail(path, `base64 byte length must be divisible by ${stride}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new DataView(bytes.buffer);
}

/** A number, or `null` for NaN. */
function real(input: unknown, path: string): number {
  if (input === null) return Number.NaN;
  if (typeof input !== 'number') fail(path, 'must be a number or null');
  return input;
}

/** Require an integer. */
export function integer(input: unknown, path: string): number {
  if (typeof input !== 'number' || !Number.isInteger(input)) fail(path, 'must be an integer');
  return input;
}

/** Require a string. */
export function string(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'must be a string');
  return input;
}

/** Require a non-null record. */
export function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(path, 'must be an object');
  }
  return input as Record<string, unknown>;
}

/** Read an own property, returning undefined when absent. */
export function optional(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/** Read a required own property. */
export function required(source: Record<string, unknown>, key: string, path: string): unknown {
  const value = optional(source, key);
  if (value === undefined) fail(`${path}.${key}`, 'is required');
  return value;
}

/** Recognize a typed array across realms without accepting shape-compatible objects. */
export function isTypedArray(value: unknown, tag: string): boolean {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === `[object ${tag}]`;
}

/** Return a stable message for a caught error. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Throw one consistently prefixed error. */
export function fail(path: string, problem: string): never {
  throw new Error(`${PREFIX}: ${path} ${problem}`);
}

/** Quote an author value in a message. */
export function quote(value: string): string {
  return JSON.stringify(value);
}
