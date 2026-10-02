import type { ColumnPage } from './materialized.js';
import { rowAt, rowCount } from './access.js';
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
