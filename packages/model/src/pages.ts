import type { ColumnPage } from './materialized.js';
import type { Domain } from './types.js';
import { rowAt, rowCount, sameIndex } from './access.js';
import type { Column } from './data.js';
import { Sequence } from './sequence.js';

export interface FrameGroup {
  readonly ordinal: number;
  readonly first: number;
  readonly coordinates: Float64Array;
  readonly pages: readonly ColumnPage[];
  readonly ranges: boolean;
}
export interface Frames {
  readonly count: number;
  readonly groups: Sequence<FrameGroup>;
  readonly first: number;
  readonly end: number;
}
const emptyFrames: Frames = { count: 0, groups: Sequence.empty(), first: 0, end: 0 };

/** Immutable pages in publication order. Obtained through createData and appendData.
 * Iteration and at() expose existing pages without copying their payloads. */
export interface ColumnPages extends Iterable<ColumnPage> {
  readonly kind: 'column-pages';
  readonly length: number;
  at(index: number): ColumnPage | undefined;
}

// Keep storage out of the public type. Collections from another copy of this package
// carry the same representation; neither reads nor copies depend on class identity.
class PageCollection implements ColumnPages {
  readonly kind = 'column-pages';
  constructor(
    readonly pages: Sequence<ColumnPage>,
    readonly frames: Frames,
  ) {}
  get length(): number {
    return this.pages.length;
  }
  at(index: number): ColumnPage | undefined {
    return this.pages.at(index);
  }
  [Symbol.iterator](): Iterator<ColumnPage> {
    return this.pages[Symbol.iterator]();
  }
}
function storage(pages: ColumnPages): PageCollection {
  return pages as PageCollection;
}
export function isColumnPages(value: unknown): value is ColumnPages {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'column-pages'
  );
}

export const emptyPages: ColumnPages = new PageCollection(Sequence.empty(), emptyFrames);

/** Append already validated pages; only the newly added groups are indexed. */
export function appendPages(before: ColumnPages, added: readonly ColumnPage[]): ColumnPages {
  const previous = storage(before);
  if (!added.length) return before;
  const grouped = new Map<number, ColumnPage[]>();
  for (const page of added)
    if (page.samples) {
      let parts = grouped.get(page.samples.firstFrame);
      if (!parts) grouped.set(page.samples.firstFrame, (parts = []));
      parts.push(page);
    }
  let count = previous.frames.count;
  const groups = [...grouped]
    .sort((a, b) => a[0] - b[0])
    .map(([first, parts]) => {
      const coordinates = parts[0].samples!.coordinates;
      const ordinal = count;
      count += coordinates.length;
      return {
        first,
        ordinal,
        coordinates,
        pages: parts.sort((a, b) => firstRow(a) - firstRow(b)),
        ranges: parts.every((page) => page.rows.kind === 'range'),
      };
    });
  const frames = groups.length
    ? {
        count,
        groups: previous.frames.groups.append(groups),
        first: previous.frames.groups.length ? previous.frames.first : groups[0].first,
        end: groups.at(-1)!.first + groups.at(-1)!.coordinates.length,
      }
    : previous.frames;
  return new PageCollection(previous.pages.append(added), frames);
}
export function copyPages(
  pages: ColumnPages,
  clone: (page: ColumnPage) => ColumnPage,
): ColumnPages {
  return appendPages(emptyPages, Array.from(pages, clone));
}
function firstRow(page: ColumnPage): number {
  return rowCount(page.rows) ? rowAt(page.rows, 0) : 0;
}
export function framesOf(pages: ColumnPages): Frames {
  return storage(pages).frames;
}
/** First and last recorded sample coordinates, or null without samples. Constant time. */
export function sampleDomain(pages: ColumnPages | undefined): Domain | null {
  const groups = pages && framesOf(pages).groups;
  const first = groups?.at(0)?.coordinates[0],
    last = groups?.at(-1)?.coordinates.at(-1);
  return first === undefined || last === undefined ? null : [first, last];
}
export function frameGroup(index: Frames, frame: number): FrameGroup | undefined {
  const next = index.groups.lowerBound((group) => group.first > frame);
  if (!next) return undefined;
  const group = index.groups.at(next - 1)!;
  return frame < group.first + group.coordinates.length ? group : undefined;
}
/** Only groups overlapping this physical frame interval. */
export function frameGroups(index: Frames, first: number, end: number): Iterable<FrameGroup> {
  if (first >= end) return [];
  const start = index.groups.lowerBound((group) => group.first + group.coordinates.length > first);
  const stop = index.groups.lowerBound((group) => group.first >= end);
  return index.groups.range(start, stop);
}

/** Pages appended after an unchanged prefix, or undefined for a replacement. No payloads are copied. */
export function appendedPages(
  before: ColumnPages,
  after: ColumnPages,
): Iterable<ColumnPage> | undefined {
  const previous = storage(before),
    next = storage(after);
  return next.pages.startsWith(previous.pages) ? next.pages.range(before.length) : undefined;
}
/**
 * Whether two collections hold the same rows and values, whatever their identity: a value
 * republished unchanged reads as unchanged. Linear in their bytes; conservative across layouts.
 */
export function samePages(a: ColumnPages, b: ColumnPages): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a.at(i)!,
      y = b.at(i)!;
    if (x === y) continue;
    if (!sameRows(x.rows, y.rows) || !sameColumn(x.column, y.column)) return false;
    if (x.samples !== y.samples)
      if (
        !x.samples ||
        !y.samples ||
        x.samples.firstFrame !== y.samples.firstFrame ||
        !sameArray(x.samples.coordinates, y.samples.coordinates)
      )
        return false;
  }
  return true;
}
function sameRows(a: ColumnPage['rows'], b: ColumnPage['rows']): boolean {
  if (a.kind === 'range') return b.kind === 'range' && a.offset === b.offset && a.count === b.count;
  return b.kind === 'indices' && sameArray(a.values, b.values);
}
function sameColumn(a: Column, b: Column): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.offset !== b.offset || a.length !== b.length) return false;
  if (!sameArray(a.validity, b.validity)) return false;
  switch (a.kind) {
    case 'text':
      return (
        sameArray(a.offsets, (b as typeof a).offsets) && sameArray(a.bytes, (b as typeof a).bytes)
      );
    case 'vector':
      return a.size === (b as typeof a).size && sameColumn(a.values, (b as typeof a).values);
    case 'list':
      return (
        sameArray(a.offsets, (b as typeof a).offsets) &&
        sameColumn(a.values, (b as typeof a).values)
      );
    case 'reference':
      return (
        sameIndex(a.index, (b as typeof a).index) && sameArray(a.values, (b as typeof a).values)
      );
    default: {
      const x = a as { values: ArrayBufferView; rowStride?: number; frameStride?: number },
        y = b as typeof x;
      return (
        x.values.constructor === y.values.constructor &&
        x.rowStride === y.rowStride &&
        x.frameStride === y.frameStride &&
        sameArray(x.values, y.values)
      );
    }
  }
}
function sameArray(a: ArrayBufferView | undefined, b: ArrayBufferView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  if (a.buffer === b.buffer && a.byteOffset === b.byteOffset) return true;
  const aligned = a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 && a.byteLength % 4 === 0,
    x = aligned
      ? new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4)
      : new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    y = aligned
      ? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
      : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
