import { failure, integer, record } from './core.js';
import type { Limits } from './types.js';

export const PROTOCOL = 'latkit';
export const Op = Object.freeze({
  register: 1,
  registered: 2,
  monitor: 3,
  run: 4,
  publication: 5,
  end: 6,
  result: 7,
  error: 8,
  cancel: 9,
  ack: 10,
  progress: 11,
  log: 12,
  close: 13,
});
export type Opcode = (typeof Op)[keyof typeof Op];
export interface Frame {
  readonly op: Opcode;
  readonly id: number;
  readonly sequence: number;
  readonly metadata: Record<string, unknown>;
  readonly body: Uint8Array;
  readonly payload: Uint8Array;
}
export interface Plan {
  readonly bytes: number;
  encode(sequence?: number): Uint8Array;
}
export type FrameLimits = Pick<Limits, 'maxMetadataBytes' | 'maxMessageBytes'>;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAGIC = 0x3154414c;
const HEADER = 24;
export const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** Bound traversal and string allocation before JSON serialization. Binary views are optional leaves. */
export function checkTree(value: unknown, bound: number, binary = false): void {
  let cost = 0,
    nodes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 8192 || depth > 24)
      throw failure('resource-limit', 'Metadata complexity limit exceeded.');
    if (item === null || typeof item === 'boolean') cost += 5;
    else if (typeof item === 'number') {
      if (!Number.isFinite(item))
        throw failure('invalid-input', 'Metadata numbers must be finite.');
      cost += 24;
    } else if (typeof item === 'string') cost += 2 + item.length * 6;
    else if (item && typeof item === 'object') {
      if (binary && ArrayBuffer.isView(item)) {
        if (!(item.buffer instanceof ArrayBuffer))
          throw failure('invalid-input', 'Shared buffers cannot be published.');
        return;
      }
      if (seen.has(item)) throw failure('invalid-input', 'Cyclic metadata.');
      if (
        !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw failure('invalid-input', 'Metadata must contain plain values.');
      if (Object.hasOwn(item, 'toJSON'))
        throw failure('invalid-input', 'Custom metadata serialization is unsupported.');
      seen.add(item);
      cost += 2;
      if (Array.isArray(item)) {
        if (item.length > 8192) throw failure('resource-limit', 'Metadata array limit exceeded.');
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, i);
          if (descriptor && !('value' in descriptor))
            throw failure('invalid-input', 'Metadata accessors are unsupported.');
          const value: unknown = descriptor?.value;
          visit(value ?? null, depth + 1);
        }
      } else
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!('value' in descriptor))
            throw failure('invalid-input', 'Metadata accessors are unsupported.');
          const value: unknown = descriptor.value;
          if (value === undefined) continue;
          cost += key.length * 6 + 4;
          visit(value, depth + 1);
          if (cost > bound * 6) throw failure('resource-limit', 'Metadata budget exceeded.');
        }
      seen.delete(item);
    } else throw failure('invalid-input', 'Unsupported metadata value.');
    if (cost > bound * 6) throw failure('resource-limit', 'Metadata budget exceeded.');
  }
  visit(value, 0);
}

/** Body fragments are borrowed until encode returns; each is aligned independently. */
export function prepare(
  op: Opcode,
  id: number,
  metadata: Record<string, unknown>,
  chunks: readonly Uint8Array[],
  bounds: FrameLimits,
): Plan {
  integer(op, 1, 13);
  integer(id, 0, 0xffffffff);
  checkTree(metadata, bounds.maxMetadataBytes);
  const json = encoder.encode(JSON.stringify(metadata));
  if (json.length > bounds.maxMetadataBytes)
    throw failure('resource-limit', 'Metadata is too large.');
  if (chunks.length > 8192) throw failure('resource-limit', 'Too many binary fragments.');
  let bodyBytes = 0;
  for (const chunk of chunks) {
    bodyBytes = align8(bodyBytes) + chunk.byteLength;
    if (bodyBytes > bounds.maxMessageBytes)
      throw failure('resource-limit', 'Binary payload is too large.');
  }
  const start = align8(HEADER + json.length),
    bytes = start + bodyBytes;
  if (bytes > bounds.maxMessageBytes) throw failure('resource-limit', 'Message is too large.');
  return {
    bytes,
    encode(sequence = 0) {
      integer(sequence, 0, 0xffffffff);
      const output = new Uint8Array(bytes),
        view = new DataView(output.buffer);
      view.setUint32(0, MAGIC, true);
      view.setUint16(4, 1, true);
      view.setUint16(6, op, true);
      view.setUint32(8, id, true);
      view.setUint32(12, sequence, true);
      view.setUint32(16, json.length, true);
      view.setUint32(20, bodyBytes, true);
      output.set(json, HEADER);
      let offset = start;
      for (const chunk of chunks) {
        offset = align8(offset);
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return output;
    },
  };
}
/** Retains stable incoming storage, copying only to correct an unaligned base address. */
export function decode(input: Uint8Array, bounds: FrameLimits): Frame {
  if (!(input.buffer instanceof ArrayBuffer))
    throw failure('protocol', 'Shared frame storage is unsupported.');
  if (input.byteLength < HEADER || input.byteLength > bounds.maxMessageBytes)
    throw failure('protocol', 'Invalid frame length.');
  const bytes = input.byteOffset % 8 ? Uint8Array.from(input) : input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== 1)
    throw failure('protocol', 'Unsupported wire version.');
  const op = integer(view.getUint16(6, true), 1, 13);
  const size = view.getUint32(16, true),
    bodySize = view.getUint32(20, true),
    start = align8(HEADER + size);
  if (size > bounds.maxMetadataBytes || start + bodySize !== bytes.length)
    throw failure('protocol', 'Inconsistent frame lengths.');
  // Publications are decoded only when consumed. The socket path validates framing and credit
  // without parsing column metadata twice or allocating wrappers for queued payloads.
  let metadata: Record<string, unknown> | undefined;
  return {
    op: op as Opcode,
    id: view.getUint32(8, true),
    sequence: view.getUint32(12, true),
    get metadata() {
      if (!metadata) {
        metadata = record(JSON.parse(decoder.decode(bytes.subarray(HEADER, HEADER + size))));
        checkTree(metadata, bounds.maxMetadataBytes);
      }
      return metadata;
    },
    body: bytes.subarray(start),
    payload: bytes.subarray(16),
  };
}
