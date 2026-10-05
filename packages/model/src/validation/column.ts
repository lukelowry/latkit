import type { DataType } from '../data.js';
import { Check, index, own } from './check.js';
import type { Path } from './check.js';

const arrays = {
  float32: Float32Array,
  float64: Float64Array,
  int32: Int32Array,
  uint32: Uint32Array,
};
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function column(
  c: Check,
  value: unknown,
  type: DataType,
  nullable: boolean,
  path: Path,
  length?: number,
  depth = 0,
  finite = false,
  active: (row: number) => boolean = () => true,
): void {
  if (depth > 32) {
    c.issue(path, 'Column nesting exceeds 32 levels.');
    return;
  }
  const col = c.object(value, path);
  const offsetValid = c.integer(col.offset, [...path, 'offset'], 0, 0x7fffffff);
  const lengthValid = c.integer(col.length, [...path, 'length'], 0, 0x7fffffff);
  if (!offsetValid || !lengthValid) return;
  const offset = col.offset as number;
  const count = col.length as number;
  const end = offset + count;
  if (end > 0x7fffffff) {
    c.issue(path, 'Slice exceeds signed 32-bit offsets.');
    return;
  }
  if (length !== undefined && count !== length)
    c.issue([...path, 'length'], 'Column length differs from its logical axis.');
  const mask = own(col, 'validity') ? bytes(c, col.validity, [...path, 'validity']) : undefined;
  if (mask && mask.length < Math.ceil(end / 8)) {
    c.issue([...path, 'validity'], 'Validity bitmap is too short.');
    return;
  }
  const present = (i: number): boolean => !mask || Boolean(mask[i >>> 3] & (1 << (i & 7)));
  if (!nullable && mask)
    for (let i = offset; i < end; i++)
      if (active(i - offset) && !present(i)) {
        c.issue([...path, 'validity'], 'Null in a non-nullable column.');
        break;
      }
  if (typeof type === 'string' && own(arrays, type)) {
    const constructor = arrays[type as keyof typeof arrays];
    if (col.kind !== 'numeric' || !(col.values instanceof constructor))
      c.issue(path, 'Numeric storage does not match its field type.');
    else if (col.values.length < end) c.issue([...path, 'values'], 'Numeric view is too short.');
    else if (finite)
      for (let i = offset; i < end; i++)
        if (active(i - offset) && present(i) && !Number.isFinite(col.values[i])) {
          c.issue([...path, 'values', i], 'Input values must be finite.');
          break;
        }
  } else if (type === 'boolean') {
    if (col.kind !== 'boolean') c.issue([...path, 'kind'], 'Expected boolean column.');
    const values = bytes(c, col.values, [...path, 'values']);
    if (values && values.length < Math.ceil(end / 8))
      c.issue([...path, 'values'], 'Boolean bitmap is too short.');
  } else if (type === 'text') {
    if (col.kind !== 'text') c.issue([...path, 'kind'], 'Expected text column.');
    const values = bytes(c, col.bytes, [...path, 'bytes']);
    const offsets = offsetsOf(c, col.offsets, offset, end, values?.length ?? 0, [
      ...path,
      'offsets',
    ]);
    if (values && offsets)
      for (let i = offset; i < end; i++)
        if (active(i - offset) && present(i)) {
          try {
            decoder.decode(values.subarray(offsets[i], offsets[i + 1]));
          } catch {
            c.issue([...path, i], 'Invalid UTF-8.');
          }
        }
  } else if (typeof type === 'object' && type.kind === 'reference') {
    if (col.kind !== 'reference') c.issue([...path, 'kind'], 'Expected reference column.');
    index(c, col.index, [...path, 'index'], type.to);
    const values = uints(c, col.values, [...path, 'values']);
    if (values && values.length < end) c.issue([...path, 'values'], 'Reference view is too short.');
  } else if (typeof type === 'object' && type.kind === 'vector') {
    if (col.kind !== 'vector' || col.size !== type.size)
      c.issue(path, 'Vector layout does not match its type.');
    column(
      c,
      col.values,
      type.items,
      false,
      [...path, 'values'],
      undefined,
      depth + 1,
      finite,
      (childRow) => {
        const row = Math.floor(childRow / type.size) - offset;
        return row >= 0 && row < count && active(row) && present(offset + row);
      },
    );
    const child = c.object(col.values, [...path, 'values']);
    if (typeof child.length === 'number' && child.length < end * type.size)
      c.issue([...path, 'values'], 'Vector child is too short.');
  } else if (typeof type === 'object' && type.kind === 'list') {
    if (col.kind !== 'list') c.issue([...path, 'kind'], 'Expected list column.');
    const child = c.object(col.values, [...path, 'values']);
    const offsets = offsetsOf(
      c,
      col.offsets,
      offset,
      end,
      typeof child.length === 'number' ? child.length : 0,
      [...path, 'offsets'],
    );
    column(
      c,
      col.values,
      type.items,
      false,
      [...path, 'values'],
      undefined,
      depth + 1,
      finite,
      (childRow) => {
        if (!offsets) return false;
        // Locate the parent interval. Empty lists contribute no items.
        let lo = offset;
        let hi = end;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (offsets[mid + 1] <= childRow) lo = mid + 1;
          else hi = mid;
        }
        return lo < end && offsets[lo] <= childRow && active(lo - offset) && present(lo);
      },
    );
  }
}

/** Row identities: a text column of nonempty strings. */
export function identities(c: Check, value: unknown, path: Path, length?: number): void {
  const before = c.issues.length;
  column(c, value, 'text', false, path, length);
  if (c.issues.length !== before) return;
  const col = value as { offset: number; length: number; offsets: Int32Array };
  for (let i = col.offset; i < col.offset + col.length; i++)
    if (col.offsets[i] === col.offsets[i + 1]) {
      c.issue([...path, i], 'Row identity must be nonempty.');
      return;
    }
}

export function bytes(c: Check, value: unknown, path: Path): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  c.issue(path, 'Expected Uint8Array.');
}

function uints(c: Check, value: unknown, path: Path, length?: number): Uint32Array | undefined {
  if (!(value instanceof Uint32Array)) {
    c.issue(path, 'Expected Uint32Array.');
    return;
  }
  if (length !== undefined && value.length !== length)
    c.issue(path, 'Array length differs from its axis.');
  return value;
}

function offsetsOf(
  c: Check,
  value: unknown,
  start: number,
  end: number,
  max: number,
  path: Path,
): Int32Array | undefined {
  if (!(value instanceof Int32Array)) {
    c.issue(path, 'Expected Int32Array.');
    return;
  }
  if (value.length < end + 1) {
    c.issue(path, 'Missing terminal offset.');
    return;
  }
  let previous = 0;
  for (let i = start; i <= end; i++) {
    if (value[i] < previous || value[i] > max) {
      c.issue([...path, i], 'Offsets must be monotone and within the child buffer.');
      return;
    }
    previous = value[i];
  }
  return value;
}
