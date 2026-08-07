import { edgeCountOf, polylinePointsOf, resolveVertexCoords } from './pack.js';
import type { Bounds, Topology } from './types.js';

/** Structural item identity kept internal to avoid coupling topology to the public controller. */
interface TopologyItem {
  readonly kind: 'vertex' | 'edge';
  readonly index: number;
}

/**
 * Bounds of unique valid items in base topology coordinates.
 *
 * A non-null longitude center enables exact circular x handling for globe
 * mode. The minimum covering arc is placed nearest that center.
 */
export function boundsForItems(
  topology: Topology,
  items: readonly TopologyItem[],
  longitudeCenter: number | null,
): Bounds | null {
  const vertexIds = new Set<number>();
  const edgeIds = new Set<number>();
  const edgeCount = edgeCountOf(topology);
  for (const item of items) {
    if (!Number.isInteger(item.index) || item.index < 0) continue;
    if (item.kind === 'vertex' && item.index < topology.vertexCount) vertexIds.add(item.index);
    else if (item.kind === 'edge' && item.index < edgeCount) edgeIds.add(item.index);
  }

  const coords = resolveVertexCoords(topology);
  const points = polylinePointsOf(topology);
  const wrap = longitudeCenter !== null;
  const viewCenter = Number.isFinite(longitudeCenter) ? longitudeCenter! : 0;
  const longitudeIntervals: Array<[number, number]> | null = wrap ? [] : null;
  let hasBounds = false;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let itemHasPoint = false;
  let itemXMin = Infinity;
  let itemXMax = -Infinity;
  let previousX = viewCenter;

  const beginItem = (): void => {
    itemHasPoint = false;
    itemXMin = Infinity;
    itemXMax = -Infinity;
    previousX = viewCenter;
  };

  const addPoint = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    hasBounds = true;
    if (longitudeIntervals) {
      const nextX = unwrapNear(x, itemHasPoint ? previousX : viewCenter);
      previousX = nextX;
      itemHasPoint = true;
      itemXMin = Math.min(itemXMin, nextX);
      itemXMax = Math.max(itemXMax, nextX);
    } else {
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
    }
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  };

  const addCoord = (values: Float32Array, index: number): void => {
    addPoint(values[index * 2]!, values[index * 2 + 1]!);
  };

  const finishItem = (): void => {
    if (longitudeIntervals && itemHasPoint) longitudeIntervals.push([itemXMin, itemXMax]);
  };

  for (const vertex of vertexIds) {
    beginItem();
    addCoord(coords, vertex);
    finishItem();
  }

  for (const edge of edgeIds) {
    beginItem();
    addCoord(coords, topology.edges[edge * 2]!);
    const lo = topology.polylineStart[edge]!;
    const hi = topology.polylineStart[edge + 1]!;
    for (let point = lo; point < hi; point++) addCoord(points, point);
    addCoord(coords, topology.edges[edge * 2 + 1]!);
    finishItem();
  }

  if (longitudeIntervals && hasBounds) {
    [xMin, xMax] = circularBounds(longitudeIntervals, viewCenter);
  }
  return hasBounds ? { xMin, xMax, yMin, yMax } : null;
}

/**
 * Give zero-width subset axes a non-zero span derived from the canonical view.
 * Projection-owned zoom normalization remains the exact final cap.
 */
export function expandDegenerateBounds(bounds: Bounds, full: Bounds, maxZoomRatio: number): Bounds {
  if (!Number.isFinite(maxZoomRatio) || maxZoomRatio <= 0) return bounds;

  const width = bounds.xMax - bounds.xMin;
  const height = bounds.yMax - bounds.yMin;
  if (width > 0 && height > 0) return bounds;

  const fullWidth = Math.max(0, full.xMax - full.xMin);
  const fullHeight = Math.max(0, full.yMax - full.yMin);
  const minSpan = Math.max(Math.max(fullWidth, fullHeight) / maxZoomRatio, Number.EPSILON);
  const centerX = (bounds.xMin + bounds.xMax) / 2;
  const centerY = (bounds.yMin + bounds.yMax) / 2;
  const halfWidth = (width > 0 ? width : minSpan) / 2;
  const halfHeight = (height > 0 ? height : minSpan) / 2;
  return {
    xMin: centerX - halfWidth,
    xMax: centerX + halfWidth,
    yMin: centerY - halfHeight,
    yMax: centerY + halfHeight,
  };
}

/** Return the minimum circular interval containing every required path interval. */
function circularBounds(intervals: Array<[number, number]>, reference: number): [number, number] {
  const segments: Array<[number, number]> = [];
  for (const [lo, hi] of intervals) {
    const width = hi - lo;
    if (width >= 360) return [reference - 180, reference + 180];
    const start = wrap360(lo);
    const end = start + width;
    if (end <= 360) segments.push([start, end]);
    else {
      segments.push([start, 360]);
      segments.push([0, end - 360]);
    }
  }

  segments.sort(intervalAscending);
  const merged: Array<[number, number]> = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && segment[0] <= previous[1]) previous[1] = Math.max(previous[1], segment[1]);
    else merged.push([...segment]);
  }

  let bestGap = -Infinity;
  let bestDistance = Infinity;
  let best: [number, number] = [merged[0]![0], merged[0]![1]];

  for (let i = 0; i < merged.length; i++) {
    const current = merged[i]!;
    const nextStart = i + 1 < merged.length ? merged[i + 1]![0] : merged[0]![0] + 360;
    const gap = nextStart - current[1];
    const start = nextStart;
    const end = current[1] + 360;
    const center = (start + end) / 2;
    const shift = Math.round((reference - center) / 360) * 360;
    const distance = Math.abs(center + shift - reference);
    if (gap > bestGap || (gap === bestGap && distance < bestDistance)) {
      bestGap = gap;
      bestDistance = distance;
      best = [start + shift, end + shift];
    }
  }

  return best;
}

/** Normalize a longitude to [0, 360). */
function wrap360(value: number): number {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Order circular coverage intervals by start, then end. */
function intervalAscending(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** Shift a longitude by whole turns to the representation nearest reference. */
function unwrapNear(value: number, reference: number): number {
  let delta = (value - reference) % 360;
  if (delta <= -180) delta += 360;
  else if (delta > 180) delta -= 360;
  return reference + delta;
}
