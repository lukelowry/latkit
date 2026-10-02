import { copyPages, isColumnPages } from './pages.js';
import type { ColumnPage } from './materialized.js';
import type { Column, NumericArray, RowAxis, SampleColumn, TextColumn } from './data.js';
import { assertIndex, bitAt, rowCount } from './access.js';
import { failure } from './error.js';

export function position(rows: RowAxis, row: number): number {
  if (rows.kind === 'range') {
    const at = row - rows.offset;
    return at >= 0 && at < rows.count ? at : -1;
  }
  let index = rowIndexes.get(rows.values);
  if (!index) {
    index = new Map<number, number>();
    for (let i = 0; i < rows.values.length; i++) index.set(rows.values[i], i);
    rowIndexes.set(rows.values, index);
  }
  return index.get(row) ?? -1;
}
const rowIndexes = new WeakMap<Uint32Array, Map<number, number>>();

export function compactRows(values: readonly number[]): RowAxis {
  if (!values.length || values.every((v, i) => v === values[0] + i))
    return { kind: 'range', offset: values[0] ?? 0, count: values.length };
  return { kind: 'indices', values: Uint32Array.from(values) };
}

export function containsRows(haystack: RowAxis, needle: RowAxis): boolean {
  if (haystack === needle) return true;
  if (haystack.kind === 'range' && needle.kind === 'range')
    return (
      needle.offset >= haystack.offset &&
      needle.offset + needle.count <= haystack.offset + haystack.count
    );
  const n = rowCount(needle);
  for (let i = 0; i < n; i++)
    if (position(haystack, needle.kind === 'range' ? needle.offset + i : needle.values[i]) < 0)
      return false;
  return true;
}

/** Compact exposed views, preserving numeric backing and bitmap alignment. */
export function sliceColumn(column: Column, start: number, count: number): Column {
  if (start < 0 || count < 0 || start + count > column.length)
    throw failure('invalid-input', 'Column slice exceeds its values.');
  const at = column.offset + start;
  if (column.kind === 'numeric' || column.kind === 'reference') {
    const base = column.validity ? at - (at & 7) : at;
    return {
      ...column,
      offset: at - base,
      length: count,
      values: column.values.subarray(base, at + count),
      ...(column.validity
        ? { validity: column.validity.subarray(base / 8, Math.ceil((at + count) / 8)) }
        : {}),
    } as Column;
  }
  if (column.kind === 'boolean') {
    const base = at >>> 3;
    return {
      ...column,
      offset: at & 7,
      length: count,
      values: column.values.subarray(base, Math.ceil((at + count) / 8)),
      ...(column.validity
        ? { validity: column.validity.subarray(base, Math.ceil((at + count) / 8)) }
        : {}),
    };
  }
  if (column.kind === 'vector') {
    const base = column.validity ? at - (at & 7) : at;
    return {
      ...column,
      offset: at - base,
      length: count,
      values: sliceColumn(
        column.values,
        base * column.size,
        (at - base + count) * column.size,
      ) as typeof column.values,
      ...(column.validity
        ? { validity: column.validity.subarray(base / 8, Math.ceil((at + count) / 8)) }
        : {}),
    };
  }
  const first = column.offsets[at],
    end = column.offsets[at + count];
  const offsets = column.offsets.subarray(at, at + count + 1);
  // Offset zero and zero-based children need no allocation.
  const normalized = first === 0 ? offsets : Int32Array.from(offsets, (value) => value - first);
  const validity = copyValidity(column, start, count);
  const common = {
    offset: 0,
    length: count,
    offsets: normalized,
    ...(validity ? { validity } : {}),
  };
  return column.kind === 'text'
    ? { kind: 'text', ...common, bytes: column.bytes.subarray(first, end) }
    : { kind: 'list', ...common, values: sliceColumn(column.values, first, end - first) };
}

export function sliceSamples(
  column: SampleColumn,
  row: number,
  rows: number,
  frame: number,
  frames: number,
): SampleColumn {
  const start = row * column.rowStride + frame * column.frameStride;
  const length =
    rows && frames ? (rows - 1) * column.rowStride + (frames - 1) * column.frameStride + 1 : 0;
  return {
    ...sliceColumn(column, start, length),
    rowStride: column.rowStride,
    frameStride: column.frameStride,
  } as SampleColumn;
}

export function copyValidity(column: Column, start: number, count: number): Uint8Array | undefined {
  if (!column.validity) return undefined;
  const bits = new Uint8Array(Math.ceil(count / 8));
  for (let i = 0; i < count; i++)
    if (bitAt(column.validity, column.offset + start + i)) bits[i >>> 3] |= 1 << (i & 7);
  return bits;
}

export interface Cell {
  readonly column: Column;
  readonly at: number;
}

/** Gather only when a selection cannot be represented by a contiguous view. */
export function gather(cells: readonly Cell[], empty: Column): Column {
  const first = cells[0]?.column ?? empty;
  if (
    cells.length &&
    cells.every((cell, i) => cell.column === first && cell.at === cells[0].at + i)
  )
    return sliceColumn(first, cells[0].at, cells.length);
  const count = cells.length;
  let validity: Uint8Array | undefined;
  if (cells.some((cell) => cell.column.validity)) {
    validity = new Uint8Array(Math.ceil(count / 8));
    for (let i = 0; i < count; i++)
      if (bitAt(cells[i].column.validity, cells[i].column.offset + cells[i].at))
        validity[i >>> 3] |= 1 << (i & 7);
  }
  const common = { offset: 0, length: count, ...(validity ? { validity } : {}) };
  if (first.kind === 'numeric' || first.kind === 'reference') {
    const Constructor = first.values.constructor as { new (length: number): NumericArray };
    const values = new Constructor(count);
    for (let i = 0; i < count; i++) {
      const c = cells[i].column;
      if (c.kind !== first.kind) throw failure('conflict', 'Column types differ.');
      if (c.kind === 'reference' && first.kind === 'reference') assertIndex(c.index, first.index);
      values[i] = (c as typeof first).values[c.offset + cells[i].at];
    }
    return { ...first, ...common, values } as Column;
  }
  if (first.kind === 'boolean') {
    const values = new Uint8Array(Math.ceil(count / 8));
    for (let i = 0; i < count; i++) {
      const c = cells[i].column;
      if (c.kind !== 'boolean') throw failure('conflict', 'Column types differ.');
      if (bitAt(c.values, c.offset + cells[i].at)) values[i >>> 3] |= 1 << (i & 7);
    }
    return { kind: 'boolean', ...common, values };
  }
  if (first.kind === 'vector') {
    const children: Cell[] = [];
    for (const cell of cells) {
      const c = cell.column;
      if (c.kind !== 'vector' || c.size !== first.size)
        throw failure('conflict', 'Vector types differ.');
      for (let lane = 0; lane < c.size; lane++)
        children.push({ column: c.values, at: (c.offset + cell.at) * c.size + lane });
    }
    return {
      kind: 'vector',
      ...common,
      size: first.size,
      values: gather(children, first.values) as typeof first.values,
    };
  }
  const offsets = new Int32Array(count + 1);
  let length = 0;
  for (let i = 0; i < count; i++) {
    const c = cells[i].column;
    if (c.kind !== first.kind) throw failure('conflict', 'Column types differ.');
    const x = c as typeof first,
      at = c.offset + cells[i].at;
    if (bitAt(c.validity, at)) length += x.offsets[at + 1] - x.offsets[at];
    if (length > 0x7fffffff) throw failure('resource-limit', 'Column offsets exceed int32.');
    offsets[i + 1] = length;
  }
  if (first.kind === 'text') {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < count; i++) {
      const c = cells[i].column as TextColumn,
        at = c.offset + cells[i].at;
      if (offsets[i + 1] !== offsets[i])
        bytes.set(c.bytes.subarray(c.offsets[at], c.offsets[at + 1]), offsets[i]);
    }
    return { kind: 'text', ...common, offsets, bytes };
  }
  const children: Cell[] = [];
  for (let i = 0; i < count; i++) {
    const c = cells[i].column;
    if (c.kind !== 'list') throw failure('conflict', 'List types differ.');
    const at = c.offset + cells[i].at;
    if (offsets[i + 1] !== offsets[i])
      for (let j = c.offsets[at]; j < c.offsets[at + 1]; j++)
        children.push({ column: c.values, at: j });
  }
  return { kind: 'list', ...common, offsets, values: gather(children, first.values) };
}

export function textColumn(values: readonly string[]): TextColumn {
  const encoder = new TextEncoder(),
    encoded = values.map((value) => encoder.encode(value));
  const offsets = new Int32Array(values.length + 1);
  for (let i = 0; i < encoded.length; i++) offsets[i + 1] = offsets[i] + encoded[i].length;
  const bytes = new Uint8Array(offsets.at(-1)!);
  for (let i = 0; i < encoded.length; i++) bytes.set(encoded[i], offsets[i]);
  return { kind: 'text', bytes, offsets, offset: 0, length: values.length } as TextColumn;
}

/** Copy only exposed views; never detach buffers owned by an application or another consumer. */
export function copyBuffers<T>(value: T): T {
  const seen = new Map<object, unknown>();
  const copy = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    const prior = seen.get(v);
    if (prior !== undefined) return prior;
    if (ArrayBuffer.isView(v)) {
      if (v instanceof DataView) {
        const result = new DataView(
          new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice().buffer,
        );
        seen.set(v, result);
        return result;
      }
      const result = (v as unknown as Uint8Array).slice();
      seen.set(v, result);
      return result;
    }
    if (isColumnPages(v)) {
      const result = copyPages(v, (page) => copy(page) as ColumnPage);
      seen.set(v, result);
      return result;
    }
    const result: unknown[] | Record<string, unknown> = Array.isArray(v) ? [] : {};
    seen.set(v, result);
    for (const [key, item] of Object.entries(v)) {
      const copied = copy(item);
      if (key === '__proto__')
        Object.defineProperty(result, key, {
          value: copied,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else (result as Record<string, unknown>)[key] = copied;
    }
    return result;
  };
  return copy(value) as T;
}
