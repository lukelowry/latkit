import { kit } from '@latkit/gpu';
import type { Shapes } from '../prepare/shapes.js';

const DEGREE = Math.PI / 180;
/** West, south, east, and north, within [-180, 180] and [-90, 90]. */
export type Box = readonly [number, number, number, number];
/** What a camera shows: one box, or two where it wraps the antimeridian. */
export type Region = readonly Box[];
const WORLD: Region = [[-180, -90, 180, 90]];

/** Boxes of a longitude range that may wrap, and a latitude range. */
function boxes(west: number, east: number, south: number, north: number): Region {
  const s = Math.max(-90, south),
    n = Math.min(90, north);
  if (east - west >= 360) return [[-180, s, 180, n]];
  const w = ((((west + 180) % 360) + 360) % 360) - 180,
    e = w + (east - west);
  return e <= 180
    ? [[w, s, e, n]]
    : [
        [w, s, 180, n],
        [-180, s, e - 360, n],
      ];
}
/** Samples across the canvas, `n` to a side, edges included. */
function samples(viewport: { width: number; height: number }, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      out.push([(viewport.width * i) / (n - 1), (viewport.height * j) / (n - 1)]);
  return out;
}

/** Where a camera looks on the earth: the boxes holding every point it can show. */
export function visibleRegion(projector: kit.Projector): Region {
  const { camera, viewport } = projector,
    globe = camera.projection === 'globe',
    pitched = kit.PROJECTIONS[camera.projection].pitched,
    points = samples(viewport, globe || pitched ? 7 : 3);
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity,
    missed = false;
  for (const point of points) {
    const hit = projector.unproject(point);
    if (!hit) {
      missed = true;
      continue;
    }
    // Longitudes relative to the center, so a view across the antimeridian stays one span.
    const x = globe ? camera.center[0] + kit.Projector.turn(camera.center[0], hit[0]) : hit[0];
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, hit[1]);
    n = Math.max(n, hit[1]);
  }
  if (globe) {
    // A pole in view shows every longitude around it.
    const pole = (latitude: number) => {
      const p = projector.project(camera.center[0], latitude);
      return p.visible && p.x >= 0 && p.y >= 0 && p.x <= viewport.width && p.y <= viewport.height;
    };
    if (missed) {
      // Past the horizon: the cap of the globe the eye can see, widened by how far it pitches.
      const distance = (viewport.height * 1.5) / (camera.scale / DEGREE) + 1,
        reach = Math.acos(Math.min(1, 1 / distance)) / DEGREE + camera.pitch,
        lat = camera.center[1];
      if (reach >= 90) return WORLD;
      const north = lat + reach,
        south = lat - reach;
      if (north >= 90 || south <= -90) return boxes(-180, 180, south, north);
      const half =
        Math.asin(Math.min(1, Math.sin(reach * DEGREE) / Math.cos(lat * DEGREE))) / DEGREE;
      return boxes(camera.center[0] - half, camera.center[0] + half, south, north);
    }
    if (pole(90)) return boxes(-180, 180, s, 90);
    if (pole(-90)) return boxes(-180, 180, -90, n);
  }
  if (!(w <= e)) return WORLD;
  if (missed) {
    // A tilted plane past its horizon: everything toward it.
    const size = Math.max(e - w, n - s) * 4;
    return boxes(w - size, e + size, s - size, n + size);
  }
  const padX = (e - w) * 0.02,
    padY = (n - s) * 0.02;
  if (globe) return boxes(w - padX, e + padX, s - padY, n + padY);
  return [
    [
      Math.max(-180, w - padX),
      Math.max(-90, s - padY),
      Math.min(180, e + padX),
      Math.min(90, n + padY),
    ],
  ];
}
/** Whether a box meets the region. */
export function meets(region: Region, w: number, s: number, e: number, n: number): boolean {
  for (const box of region)
    if (w <= box[2] && e >= box[0] && s <= box[3] && n >= box[1]) return true;
  return false;
}
/** Whether a box lies wholly inside one of the region's boxes. */
function within(region: Region, w: number, s: number, e: number, n: number): boolean {
  for (const box of region)
    if (w >= box[0] && e <= box[2] && s >= box[1] && n <= box[3]) return true;
  return false;
}
/** CSS pixels per degree where the camera looks, as the finest detail it shows. */
export function pixelsPerDegree(projector: kit.Projector): number {
  const { camera } = projector;
  let scale = camera.scale;
  if (camera.projection === 'mercator')
    scale /= Math.max(0.05, Math.cos(camera.center[1] * DEGREE));
  // A tilted view shows its near ground larger than its center.
  if (kit.PROJECTIONS[camera.projection].pitched) scale *= 1 + camera.pitch / 45;
  return scale;
}
/** The coarsest level that draws faithfully at the camera's detail: what drops stays under half a pixel. */
export function levelFor(shapes: Shapes, pixels: number): number {
  const tolerance = 0.5 / (pixels * pixels),
    { levels } = shapes;
  for (let k = 0; k < levels.length; k++) if (levels[k].tolerance <= tolerance) return k;
  return levels.length - 1;
}
/** A node's loose bounds: its cell grown by half on every side, as pieces are filed. */
function looseBounds(depth: number, x: number, y: number): [number, number, number, number] {
  const w = 360 / 2 ** depth,
    h = 180 / 2 ** depth,
    west = -180 + x * w - w / 2,
    south = -90 + y * h - h / 2;
  return [west, south, west + 2 * w, south + 2 * h];
}
/**
 * The ranges of a level's triangles or strips the region shows, as first and count pairs: a node
 * wholly in view adds its subtree as one range, and adjacent ranges merge.
 */
export function visibleRanges(
  shapes: Shapes,
  level: number,
  region: Region,
  of: 'triangles' | 'strips',
): number[] {
  const { cells, next } = shapes.nodes,
    starts = shapes.nodes[of][level],
    out: number[] = [];
  const add = (first: number, end: number) => {
    if (end <= first) return;
    const last = out.length - 2;
    if (last >= 0 && out[last] + out[last + 1] === first) out[last + 1] += end - first;
    else out.push(first, end - first);
  };
  const count = next.length;
  let node = 0;
  while (node < count) {
    const [w, s, e, n] = looseBounds(cells[node * 3], cells[node * 3 + 1], cells[node * 3 + 2]);
    if (!meets(region, w, s, e, n)) {
      node = next[node];
      continue;
    }
    if (within(region, w, s, e, n)) {
      add(starts[node], starts[next[node]]);
      node = next[node];
      continue;
    }
    add(starts[node], starts[node + 1]);
    node++;
  }
  return out;
}
/** The pieces the region may show near a point, for picking: those of every node whose bounds hold it. */
export function piecesNear(shapes: Shapes, w: number, s: number, e: number, n: number): number[] {
  const { cells, next, pieces } = shapes.nodes,
    out: number[] = [],
    count = next.length;
  let node = 0;
  while (node < count) {
    const [nw, ns, ne, nn] = looseBounds(cells[node * 3], cells[node * 3 + 1], cells[node * 3 + 2]);
    if (w > ne || e < nw || s > nn || n < ns) {
      node = next[node];
      continue;
    }
    for (let p = pieces[node]; p < pieces[node + 1]; p++) {
      const b = p * 4,
        bounds = shapes.pieceBounds;
      if (w <= bounds[b + 2] && e >= bounds[b] && s <= bounds[b + 3] && n >= bounds[b + 1])
        out.push(p);
    }
    node++;
  }
  return out;
}
