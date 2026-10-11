import { isColumnPages } from './pages.js';
/** Deduplicated backing allocations. Only transfer these for a query requested with buffers: owned. */
export function blockBuffers(block: unknown): readonly ArrayBufferLike[] {
  const buffers = new Set<ArrayBufferLike>();
  visit(block, (value) => {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  });
  return [...buffers];
}

/**
 * Payload accounting: union of exposed byte ranges per allocation, UTF-8 strings (including keys),
 * eight bytes per numeric metadata value, one per boolean/null. Excludes allocation/transport/object
 * overhead. Borrowed views may retain larger backing allocations; inspect blockBuffers for those.
 */
export function blockByteLength(block: unknown): number {
  return measure(block).bytes;
}

/** The binary part of blockByteLength: the union of exposed view ranges per allocation. */
export function exposedBytes(block: unknown): number {
  return measure(block).exposed;
}

function measure(block: unknown): { bytes: number; exposed: number } {
  const ranges = new Map<ArrayBufferLike, [number, number][]>();
  let bytes = 0;
  visit(block, (value) => {
    if (ArrayBuffer.isView(value)) {
      const list = ranges.get(value.buffer) ?? [];
      list.push([value.byteOffset, value.byteOffset + value.byteLength]);
      ranges.set(value.buffer, list);
    } else if (typeof value === 'string') bytes += utf8Length(value);
    else if (typeof value === 'number') bytes += 8;
    else if (typeof value === 'boolean' || value === null) bytes += 1;
  });
  let exposed = 0;
  for (const list of ranges.values()) {
    list.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [start, next] of list) {
      exposed += Math.max(0, next - Math.max(start, end));
      end = Math.max(end, next);
    }
  }
  return { bytes: bytes + exposed, exposed };
}

function visit(value: unknown, consume: (value: unknown) => void): void {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) continue;
      seen.add(current);
      if (ArrayBuffer.isView(current)) consume(current);
      else if (Array.isArray(current) || isColumnPages(current))
        for (const item of current) pending.push(item);
      else
        for (const [key, item] of Object.entries(current)) {
          consume(key);
          pending.push(item);
        }
    } else consume(current);
  }
}

function utf8Length(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}
