import { rowAt, type Data, type Item } from '@latkit/model';
import type { kit, Point } from '@latkit/gpu';
import { cutEdge, type Shapes } from './prepare/shapes.js';
import { piecesNear } from './scene/visible.js';

/** An item a geography draws: a row of an area or line type. */
export interface GeographyItem extends Item {
  readonly kind: 'area' | 'line';
}
/** A record as a frame drew it, which picking searches: topmost last. */
export interface Drawn {
  readonly kind: 'area' | 'line';
  readonly source: Data;
  readonly type: string;
  readonly shapes: Shapes;
  /** Half the width lines draw at, in CSS pixels, which counts as on the line. */
  readonly halfWidth: number;
}
interface Hit {
  readonly item: GeographyItem;
  readonly distance: number;
  readonly order: number;
}

/** Each set of shapes' vertices as words, to read their rows. */
const words = new WeakMap<Shapes, Uint32Array>();
/** A vertex's longitude and latitude: its row's origin, rejoined, plus its offset. */
function pointOf(shapes: Shapes, v: number): [number, number] {
  let view = words.get(shapes);
  if (!view)
    words.set(
      shapes,
      (view = new Uint32Array(
        shapes.vertices.buffer,
        shapes.vertices.byteOffset,
        shapes.vertices.length,
      )),
    );
  const row = view[v * 3 + 2],
    o = shapes.origins;
  return [
    o[row * 4] + o[row * 4 + 2] + shapes.vertices[v * 3],
    o[row * 4 + 1] + o[row * 4 + 3] + shapes.vertices[v * 3 + 1],
  ];
}
/** The parts of a piece, as first and end vertices. */
function* partsOf(shapes: Shapes, piece: number): Generator<readonly [number, number]> {
  const first = shapes.pieces[piece * 3 + 1],
    count = shapes.pieces[piece * 3 + 2];
  for (let k = 0; k < count; k++) {
    const part = shapes.pieceParts[first + k];
    yield [shapes.parts[part], shapes.parts[part + 1]];
  }
}
/** Whether a point lies in a piece's polygon, by the even-odd rule over its rings. */
function inside(shapes: Shapes, piece: number, x: number, y: number): boolean {
  let within = false;
  for (const [first, end] of partsOf(shapes, piece)) {
    let [bx, by] = pointOf(shapes, end - 1);
    for (let v = first; v < end; v++) {
      const [ax, ay] = pointOf(shapes, v);
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within;
      bx = ax;
      by = ay;
    }
  }
  return within;
}
/** The distance in CSS pixels from a canvas point to a segment between two projected points. */
function segmentDistance(p: Point, a: kit.Projected, b: kit.Projected): number {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = dx * dx + dy * dy,
    t = length > 0 ? Math.max(0, Math.min(1, ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a.x + dx * t), p[1] - (a.y + dy * t));
}
/** A row's item. */
export function itemOf(
  kind: 'area' | 'line',
  source: Data,
  type: string,
  position: number,
): GeographyItem {
  const table = source.tables[type];
  return { kind, source, index: table.index, row: rowAt(table.rows, position) };
}
/** The CSS pixels a degree spans each way at a point, at least a little. */
function pixelsAt(projector: kit.Projector, x: number, y: number): readonly [number, number] {
  const step = 0.01,
    p = projector.project(x, y),
    east = projector.project(x + step, y),
    north = projector.project(x, Math.min(90, y + step));
  const fallback = projector.camera.scale;
  if (!p.visible || !east.visible || !north.visible) return [fallback, fallback];
  return [
    Math.max(1e-9, Math.hypot(east.x - p.x, east.y - p.y) / step),
    Math.max(1e-9, Math.hypot(north.x - p.x, north.y - p.y) / step),
  ];
}

/**
 * The rows near a canvas point in what a frame drew: an area holding it, or a line within the
 * radius. Nearest first, the topmost breaking ties; a point on a line's stroke is on it.
 */
export function pick(
  drawn: readonly Drawn[],
  projector: kit.Projector,
  point: Point,
  radiusPx: number,
  limit: number,
  check?: () => void,
): GeographyItem[] {
  const at = projector.unproject(point);
  if (!at) return [];
  const [x, y] = at,
    [px, py] = pixelsAt(projector, x, y),
    hits = new Map<string, Hit>();
  const keep = (item: GeographyItem, distance: number, order: number) => {
    const key = `${order}:${item.row}`,
      before = hits.get(key);
    if (!before || distance < before.distance) hits.set(key, { item, distance, order });
  };
  drawn.forEach((record, order) => {
    const { shapes, kind, source, type } = record;
    if (kind === 'area') {
      for (const piece of piecesNear(shapes, x, y, x, y)) {
        check?.();
        if (inside(shapes, piece, x, y))
          keep(itemOf(kind, source, type, shapes.pieces[piece * 3]), 0, order);
      }
      return;
    }
    const reach = radiusPx + record.halfWidth,
      dx = reach / px,
      dy = reach / py;
    for (const piece of piecesNear(shapes, x - dx, y - dy, x + dx, y + dy)) {
      check?.();
      let best = Infinity;
      for (const [first, end] of partsOf(shapes, piece)) {
        const count = shapes.closed ? end - first + 1 : end - first;
        let [ax, ay] = pointOf(shapes, first),
          pa: kit.Projected | undefined;
        for (let k = 1; k < count; k++) {
          const [bx, by] = pointOf(shapes, first + (k % (end - first)));
          const near =
            Math.min(ax, bx) <= x + dx &&
            Math.max(ax, bx) >= x - dx &&
            Math.min(ay, by) <= y + dy &&
            Math.max(ay, by) >= y - dy;
          if (near && !(shapes.closed && cutEdge(ax, ay, bx, by))) {
            pa ??= projector.project(ax, ay);
            const pb = projector.project(bx, by);
            if (pa.visible && pb.visible) best = Math.min(best, segmentDistance(point, pa, pb));
            pa = pb;
          } else pa = undefined;
          ax = bx;
          ay = by;
        }
      }
      if (best <= reach)
        keep(
          itemOf(kind, source, type, shapes.pieces[piece * 3]),
          Math.max(0, best - record.halfWidth),
          order,
        );
    }
  });
  return [...hits.values()]
    .sort((a, b) => a.distance - b.distance || b.order - a.order)
    .slice(0, limit)
    .map((hit) => hit.item);
}
