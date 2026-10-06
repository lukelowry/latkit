import { samePages, sameIndex, type Data, type TypeDefinition } from '@latkit/model';
import { bindChannels, type ChannelKind } from '../style/channel.js';

/** A plain object: one a literal or JSON makes. */
export function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/**
 * Whether two option values are the same: plain objects, arrays, and typed arrays by what they
 * hold; functions and other instances only as themselves. A `source` holds data, which is new as
 * itself: the view decides what of new data is new.
 */
export function same(a: unknown, b: unknown, key?: string): boolean {
  if (a === b) return true;
  if (key === 'source') return false;
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  // Rows rebuilt as an equal Uint32Array are the same rows.
  if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && sameBytes(a, b);
  if (!plain(a) || !plain(b)) return false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!same(a[k], b[k], k)) return false;
  return true;
}
function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
/**
 * Whether two options read the same: equal but for how their color channels look, which is a
 * colormap, a domain, a missing color, or a fixed color. A view keeps what it read across such a
 * change, and maps the new look with uniforms.
 */
export function sameReads<K extends string>(
  a: object,
  b: object,
  kinds: Readonly<Record<K, ChannelKind>>,
): boolean {
  const x = a as Readonly<Record<string, unknown>>,
    y = b as Readonly<Record<string, unknown>>,
    kind = kinds as Readonly<Record<string, ChannelKind>>;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (kind[key] !== 'color') {
      if (!same(x[key], y[key], key)) return false;
      continue;
    }
    const color = { [key]: 'color' } as const,
      p = bindChannels({ [key]: x[key] }, color).channels[key],
      q = bindChannels({ [key]: y[key] }, color).channels[key];
    if (p.component !== q.component || !same(p.field, q.field)) return false;
  }
  return true;
}

/** Whether two keyed records name the same entries in order, each the same under `keys`. */
export function sameRecords<T extends object>(
  a: Readonly<Record<string, T>> | undefined,
  b: Readonly<Record<string, T>> | undefined,
  keys: readonly (keyof T)[],
): boolean {
  if (a === b) return true;
  const xs = Object.keys(a ?? {}),
    ys = Object.keys(b ?? {});
  return (
    xs.length === ys.length &&
    xs.every((type, i) => type === ys[i] && keys.every((key) => a![type][key] === b![type][key]))
  );
}
/**
 * Whether two Data values number the same rows, under the same ids, and hold the same values in
 * the fields `fields` names for each type, whatever their identity: a value republished unchanged
 * reads as the same, so a view rebuilds only what its data changed.
 */
export function sameValues(
  a: Data,
  b: Data,
  fields: (type: string, definition: TypeDefinition) => readonly string[],
): boolean {
  if (a === b) return true;
  const types = Object.keys(a.tables);
  if (a.schema !== b.schema || types.length !== Object.keys(b.tables).length) return false;
  for (const type of types) {
    const x = a.tables[type],
      y = b.tables[type];
    if (!y || !sameIndex(x.index, y.index) || !samePages(x.ids, y.ids)) return false;
    if (
      x.rows !== y.rows &&
      (x.rows.kind !== 'range' ||
        y.rows.kind !== 'range' ||
        x.rows.offset !== y.rows.offset ||
        x.rows.count !== y.rows.count)
    )
      return false;
    for (const field of fields(type, a.schema.types[type])) {
      const before = x.fields[field],
        after = y.fields[field];
      if (before !== after && (!before || !after || !samePages(before, after))) return false;
    }
  }
  return true;
}
