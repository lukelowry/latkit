import { type ColumnPages, appendPages, framesOf } from './pages.js';
import type { RowAxis } from './data.js';
import type { ColumnPage } from './materialized.js';
import { failure } from './error.js';

interface Tail {
  readonly end: number;
  readonly coordinate: number;
}
const coordinatesChecked = new WeakSet<Float64Array>();
type Range = readonly [number, number];
const rowRanges = new WeakMap<RowAxis, readonly Range[]>();

interface Extent extends Tail {
  readonly first: number;
  readonly firstCoordinate: number;
}

/** One assembly shares layout validation across aligned columns, never across changed data. */
export class PageAssembly {
  private checked?: { pages: readonly ColumnPage[]; extent?: Extent };

  append(before: ColumnPages, added: readonly ColumnPage[]): ColumnPages {
    if (!added.length) return before;
    const checked = this.checked;
    const same =
      checked &&
      added.length === checked.pages.length &&
      added.every(
        (page, i) =>
          page.rows === checked.pages[i].rows && page.samples === checked.pages[i].samples,
      );
    const extent = same ? checked.extent : checkPages(added);
    this.checked = { pages: added, extent };
    if (extent) {
      const tail = sampleTail(before);
      if (extent.first < tail.end || extent.firstCoordinate < tail.coordinate)
        throw failure('conflict', 'Samples must append after existing observations.');
    }
    return appendPages(before, added);
  }
}

function checkPages(added: readonly ColumnPage[]): Extent | undefined {
  let extent: Extent | undefined;
  if (added[0].samples) {
    const groups = new Map<number, { coordinates: Float64Array; rows: RowAxis[] }>();
    for (const page of added) {
      const { firstFrame, coordinates } = page.samples!;
      if (
        !Number.isSafeInteger(firstFrame) ||
        firstFrame < 0 ||
        !Number.isSafeInteger(firstFrame + coordinates.length)
      )
        throw failure('invalid-input', 'Invalid sample frame range.');
      if (!coordinatesChecked.has(coordinates)) {
        let last = -Infinity;
        for (const coordinate of coordinates) {
          if (!Number.isFinite(coordinate) || coordinate < last)
            throw failure('conflict', 'Sample coordinates must be finite and nondecreasing.');
          last = coordinate;
        }
        coordinatesChecked.add(coordinates);
      }
      const group = groups.get(firstFrame);
      if (group) {
        if (
          coordinates !== group.coordinates &&
          (coordinates.length !== group.coordinates.length ||
            coordinates.some((c, i) => c !== group.coordinates[i]))
        )
          throw failure('conflict', 'Sample tile coordinates differ.');
        group.rows.push(page.rows);
      } else groups.set(firstFrame, { coordinates, rows: [page.rows] });
    }
    let tail: Tail = { end: 0, coordinate: -Infinity };
    for (const [first, group] of [...groups].sort((a, b) => a[0] - b[0])) {
      if (first < tail.end || group.coordinates[0] < tail.coordinate)
        throw failure('conflict', 'Samples must append after existing observations.');
      checkRows(group.rows);
      extent ??= { first, firstCoordinate: group.coordinates[0], end: 0, coordinate: -Infinity };
      tail = { end: first + group.coordinates.length, coordinate: group.coordinates.at(-1)! };
      extent = { ...extent, ...tail };
    }
  } else {
    checkRows(added.map((page) => page.rows));
  }
  return extent;
}

function sampleTail(pages: ColumnPages): Tail {
  const frames = framesOf(pages);
  return { end: frames.end, coordinate: frames.groups.at(-1)?.coordinates.at(-1) ?? -Infinity };
}

/** Rectangular row tiles and sparse selections must not overwrite the same cells. */
function checkRows(axes: readonly RowAxis[]): void {
  // Already ordered dense tiles are the common case. Avoid sorting or allocating
  // a flattened range list unless the incoming physical row order requires it.
  let end = -Infinity;
  let ordered = true;
  for (const axis of axes) {
    for (const range of rangesOf(axis)) {
      if (range[0] < end) {
        ordered = false;
        break;
      }
      end = range[1];
    }
    if (!ordered) break;
  }
  if (ordered) return;
  const ranges = axes.flatMap((axis) => rangesOf(axis));
  ranges.sort((a, b) => a[0] - b[0]);
  end = -Infinity;
  for (const range of ranges) {
    if (range[0] < end) throw failure('conflict', 'Data batches overlap the same cells.');
    end = range[1];
  }
}

function rangesOf(axis: RowAxis): readonly Range[] {
  let ranges = rowRanges.get(axis);
  if (ranges) return ranges;
  if (axis.kind === 'range') {
    if (
      !Number.isSafeInteger(axis.offset) ||
      axis.offset < 0 ||
      !Number.isSafeInteger(axis.count) ||
      axis.count < 0 ||
      !Number.isSafeInteger(axis.offset + axis.count)
    )
      throw failure('invalid-input', 'Invalid row range.');
    ranges = axis.count ? [[axis.offset, axis.offset + axis.count]] : [];
  } else {
    let values = axis.values;
    for (let i = 1; i < values.length; i++)
      if (values[i] <= values[i - 1]) {
        values = values.slice().sort();
        break;
      }
    const parts: Range[] = [];
    for (let i = 0; i < values.length;) {
      const start = values[i++];
      let end = start + 1;
      while (i < values.length && values[i] <= end) {
        if (values[i] < end) throw failure('conflict', 'Duplicate physical row.');
        end = values[i++] + 1;
      }
      parts.push([start, end]);
    }
    ranges = parts;
  }
  rowRanges.set(axis, ranges);
  return ranges;
}
