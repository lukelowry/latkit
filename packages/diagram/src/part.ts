/**
 * Part identity: the public `{ kind, index }` record and the one number selection, hover, and
 * picking store it as, so a set of parts is a set of numbers and a part id fits a u32.
 */

/** A pickable piece of a diagram: a block, a port, a net, or a group, by index. */
export interface Part {
  readonly kind: 'block' | 'port' | 'net' | 'group';
  readonly index: number;
}

/** Part kind codes, shared with the shaders' `PART_*` constants and the pick index. */
export const PART_BLOCK = 0;
export const PART_PORT = 1;
export const PART_NET = 2;
export const PART_GROUP = 3;

/** Part kinds by code. */
export const KINDS = Object.freeze(['block', 'port', 'net', 'group'] as const);

/** One part kind's range of ids: `2 ** 30` indices, so four kinds fit a u32. */
const SPAN = 2 ** 30;

/** The id of part `index` of kind code `kind`; `index` must be below `2 ** 30`. */
export function partId(kind: number, index: number): number {
  return kind * SPAN + index;
}

/** The kind code of a part id. */
export function partKind(id: number): number {
  return Math.floor(id / SPAN);
}

/** The index of a part id within its kind. */
export function partIndex(id: number): number {
  return id % SPAN;
}

/** The part a part id names. */
export function partOf(id: number): Part {
  return { kind: KINDS[partKind(id)]!, index: partIndex(id) };
}

/** The id of a part; `-1` for a record that names no kind or no valid index. */
export function idOf(part: Part): number {
  const kind = KINDS.indexOf(part.kind);
  const index = part.index;
  if (kind < 0 || !Number.isSafeInteger(index) || index < 0 || index >= SPAN) return -1;
  return partId(kind, index);
}

/** Whether two records name the same part. */
export function samePart(a: Part, b: Part): boolean {
  return a.kind === b.kind && a.index === b.index;
}
