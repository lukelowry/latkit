import { Check } from './check.js';
import type { Path } from './check.js';

/** Validation uses constant-space access to ranges; never expand identity arrays. */
export function rowAxis(
  c: Check,
  value: unknown,
  path: Path,
):
  | {
      length: number;
      at: (position: number) => number;
      range?: { offset: number; count: number };
    }
  | undefined {
  const axis = c.object(value, path);
  if (axis.kind === 'range') {
    const start = c.integer(axis.offset, [...path, 'offset'], 0, 0xffffffff);
    const count = c.integer(axis.count, [...path, 'count'], 0, 0x100000000);
    if (!start || !count) return;
    const offset = axis.offset as number;
    const length = axis.count as number;
    if (offset + length > 0x100000000) {
      c.issue(path, 'Range exceeds uint32 address space.');
      return;
    }
    return { length, at: (i) => offset + i, range: { offset, count: length } };
  }
  if (axis.kind !== 'indices' || !(axis.values instanceof Uint32Array)) {
    c.issue(path, 'Expected a physical row range or Uint32 index selection.');
    return;
  }
  const values = axis.values;
  if (new Set(values).size !== values.length) c.issue(path, 'Duplicate physical row.');
  return { length: values.length, at: (i) => values[i] };
}
