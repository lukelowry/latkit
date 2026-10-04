import { failure } from '@latkit/model';
import { kit, type Point } from '@latkit/gpu';
import type { RouteEnd } from './data.js';
import type { Arrow, Edge, End, GroupBox, Rect, Scene, Vertex, Wire } from './scene.js';
import { union, expand, intersects } from './scene.js';
import { boundary } from './geometry.js';
import type { Style } from './config.js';

/** A scene's obstacles: its drawn vertices and collapsed groups, kept so a drag reroutes. */
export interface Obstacles {
  readonly index: kit.BoxIndex;
  /** Four per owner: each vertex, then each collapsed group; NaN for an owner not drawn. */
  readonly boxes: Float64Array;
  readonly count: number;
  /** The collapsed group that stands in for each hidden vertex. */
  readonly proxy: ReadonlyMap<number, string>;
  readonly proxyOwner: ReadonlyMap<string, number>;
  /** The group of each proxy owner, past the vertices. */
  readonly proxyGroups: readonly string[];
  readonly groups: ReadonlyMap<string, GroupBox>;
}
/** Vertices and groups a drag moves by one delta, routed where they are going. */
export interface Moved {
  readonly vertices: ReadonlyMap<number, Vertex>;
  readonly groups: ReadonlySet<string>;
  readonly delta: Point;
}
/** An end as routing reads it: where its wire meets it, the way out, and what it belongs to. */
interface Terminal extends RouteEnd {
  readonly owner: number;
  /** The port itself, or the boundary point, which the wire reaches through `position`. */
  readonly anchor: Point;
  readonly port: boolean;
  readonly arrow: boolean;
}
/**
 * One edge's route before tracks set it apart from other nets: a tree of joints, each segment
 * running to its parent, or a strategy's own paths. Unchanged edges keep it between scenes.
 */
export interface Route {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly parent: Int32Array;
  /** 1 a port or end point, which never moves; 2 a stub end, whose stub only grows. */
  readonly kind: Uint8Array;
  /** Each stub end's port. */
  readonly stub: Int32Array;
  readonly arrows: readonly Arrow[];
  /** Paths drawn as given, without a tree: straight wires and strategies. */
  readonly paths?: readonly (readonly Point[])[];
  /** Route points, for the route budget. */
  readonly points: number;
}

export function obstacles(scene: Scene, hidden: ReadonlySet<number>): Obstacles {
  const groups = new Map(scene.groups.map((g) => [g.id, g])),
    proxy = new Map<number, string>(),
    proxyOwner = new Map<string, number>(),
    proxyGroups: string[] = [];
  for (let i = 0; i < scene.vertices.length; i++) {
    let collapsed: string | undefined;
    for (let group = scene.vertices[i].group; group; group = groups.get(group)?.parent)
      if (groups.get(group)?.collapsed) collapsed = group;
    if (collapsed) proxy.set(i, collapsed);
  }
  for (const group of scene.groups)
    if (group.collapsed && group.bounds[0] !== group.bounds[2]) {
      proxyOwner.set(group.id, scene.vertices.length + proxyGroups.length);
      proxyGroups.push(group.id);
    }
  const count = scene.vertices.length + proxyGroups.length,
    boxes = new Float64Array(count * 4).fill(NaN);
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  for (let owner = 0; owner < count; owner++) {
    const vertex = scene.vertices[owner];
    const box: Rect | null =
      owner < scene.vertices.length
        ? vertex.visible && !hidden.has(owner)
          ? [vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height]
          : null
        : groups.get(proxyGroups[owner - scene.vertices.length])!.bounds;
    if (!box) continue;
    boxes.set(box, owner * 4);
    extent[0] = Math.min(extent[0], box[0]);
    extent[1] = Math.min(extent[1], box[1]);
    extent[2] = Math.max(extent[2], box[2]);
    extent[3] = Math.max(extent[3], box[3]);
  }
  const index = kit.BoxIndex.of(count, extent as unknown as Rect, (i, box) =>
    box.set(boxes.subarray(i * 4, i * 4 + 4)),
  );
  return { index, boxes, count, proxy, proxyOwner, proxyGroups, groups };
}

/** What routing reads of a scene, with what a drag moves where it is going. */
export class Routing {
  private readonly shifted: readonly Rect[];
  constructor(
    readonly scene: Scene,
    readonly options: Style,
    readonly signal: AbortSignal,
    private readonly moved?: Moved,
  ) {
    const o = scene.obstacles!,
      shifted: Rect[] = [];
    if (moved)
      for (let owner = 0; owner < o.count; owner++)
        if (this.moves(owner) && Number.isFinite(o.boxes[owner * 4]))
          shifted.push(this.box(owner)!);
    this.shifted = shifted;
  }
  vertex(index: number): Vertex {
    return this.moved?.vertices.get(index) ?? this.scene.vertices[index];
  }
  private moves(owner: number): boolean {
    const { moved } = this;
    if (!moved) return false;
    const count = this.scene.vertices.length;
    return owner < count
      ? moved.vertices.has(owner)
      : moved.groups.has(this.scene.obstacles!.proxyGroups[owner - count]);
  }
  /** An owner's box where the drag has it; undefined for one not drawn. */
  box(owner: number): Rect | undefined {
    const b = this.scene.obstacles!.boxes,
      at = owner * 4;
    if (!Number.isFinite(b[at])) return undefined;
    const d = this.moves(owner) ? this.moved!.delta : [0, 0];
    return [b[at] + d[0], b[at + 1] + d[1], b[at + 2] + d[0], b[at + 3] + d[1]];
  }
  /** Obstacle boxes meeting a region, grown by `by`. */
  query(region: Rect, by: number): Rect[] {
    const out: Rect[] = [],
      b = this.scene.obstacles!.boxes;
    for (const owner of this.scene.obstacles!.index.query(region)) {
      if (this.moved && this.moves(owner)) continue;
      const at = owner * 4;
      if (
        b[at] <= region[2] &&
        b[at + 2] >= region[0] &&
        b[at + 1] <= region[3] &&
        b[at + 3] >= region[1]
      )
        out.push([b[at] - by, b[at + 1] - by, b[at + 2] + by, b[at + 3] + by]);
    }
    for (const box of this.shifted)
      if (box[0] <= region[2] && box[2] >= region[0] && box[1] <= region[3] && box[3] >= region[1])
        out.push([box[0] - by, box[1] - by, box[2] + by, box[3] + by]);
    return out;
  }
  /** Whether an axis-aligned segment keeps out of every obstacle grown by `by`. */
  clear(a: Point, b: Point, by: number): boolean {
    const x0 = Math.min(a[0], b[0]),
      y0 = Math.min(a[1], b[1]),
      x1 = Math.max(a[0], b[0]),
      y1 = Math.max(a[1], b[1]);
    for (const box of this.query([x0 - by, y0 - by, x1 + by, y1 + by], by))
      if (crosses(a, b, box)) return false;
    return true;
  }
  /** Where an end's wire meets it, the way out, and its owner, leaving toward a point. */
  end(e: End, toward: Point, arrows: boolean): Terminal {
    const o = this.scene.obstacles!,
      half = this.options.portSize / 2,
      group = o.proxy.get(e.vertex),
      arrow = arrows && e.direction === 'in';
    if (group && o.groups.get(group)) {
      const owner = o.proxyOwner.get(group)!,
        b = this.box(owner)!,
        box = {
          x: b[0],
          y: b[1],
          width: b[2] - b[0],
          height: b[3] - b[1],
          shape: 'rectangle' as const,
        },
        p = boundary({ ...this.vertex(e.vertex), ...box }, toward);
      return terminal(p, side(box, p), e, owner, p, false, arrow);
    }
    const n = this.vertex(e.vertex),
      port = e.port ? n.ports.find((p) => p.name === e.port) : undefined;
    if (port) {
      // The wire meets the marker's outer edge: an input's marker is its arrowhead.
      const edge: Point = [
        port.position[0] + port.normal[0] * half,
        port.position[1] + port.normal[1] * half,
      ];
      return terminal(edge, port.normal, e, e.vertex, port.position, true, false);
    }
    const p = boundary(n, toward);
    return terminal(p, side(n, p), e, e.vertex, p, false, arrow);
  }
}
function terminal(
  position: Point,
  normal: Point,
  e: End,
  owner: number,
  anchor: Point,
  port: boolean,
  arrow: boolean,
): Terminal {
  return {
    position,
    normal,
    owner,
    anchor,
    port,
    arrow,
    ...(e.direction ? { direction: e.direction } : {}),
  };
}
/** The axis normal of a vertex's side nearest a boundary point. */
function side(vertex: { x: number; y: number; width: number; height: number }, p: Point): Point {
  const dx = p[0] - vertex.x - vertex.width / 2,
    dy = p[1] - vertex.y - vertex.height / 2;
  return Math.abs(dx / vertex.width) > Math.abs(dy / vertex.height)
    ? [Math.sign(dx) || 1, 0]
    : [0, Math.sign(dy) || 1];
}
/** Whether an axis-aligned segment passes through a box's interior. */
function crosses(a: Point, b: Point, box: Rect): boolean {
  const e = 1e-6;
  if (a[0] === b[0])
    return (
      a[0] > box[0] + e &&
      a[0] < box[2] - e &&
      Math.max(a[1], b[1]) > box[1] + e &&
      Math.min(a[1], b[1]) < box[3] - e
    );
  return (
    a[1] > box[1] + e &&
    a[1] < box[3] - e &&
    Math.max(a[0], b[0]) > box[0] + e &&
    Math.min(a[0], b[0]) < box[2] - e
  );
}
const manhattan = (a: Point, b: Point) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** A net while it is planned: joints, each joined to its parent by an axis-aligned segment. */
class Tree {
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly parent: number[] = [];
  readonly kind: number[] = [];
  readonly stub: number[] = [];
  add(p: Point, parent: number, kind = 0): number {
    const j = this.x.push(p[0]) - 1;
    this.y.push(p[1]);
    this.parent.push(parent);
    this.kind.push(kind);
    this.stub.push(-1);
    return j;
  }
  point(j: number): Point {
    return [this.x[j], this.y[j]];
  }
  /** A joint on the segment from `child` to its parent. */
  split(child: number, p: Point): number {
    const j = this.add(p, this.parent[child]);
    this.parent[child] = j;
    return j;
  }
  /**
   * Where a reader may join, nearest `toward` first: each joint off a port, and each segment's
   * nearest point to `toward`. Segments into ports are stubs, which no branch joins.
   */
  joins(toward: Point): { point: Point; child: number; interior: boolean }[] {
    const out: { point: Point; child: number; interior: boolean }[] = [];
    for (let j = 1; j < this.x.length; j++) {
      const p = this.parent[j],
        a = this.point(p),
        b = this.point(j);
      const stub = this.kind[p] === 1 || this.kind[j] === 1;
      if (this.kind[p] !== 1) out.push({ point: a, child: j, interior: false });
      if (this.kind[j] !== 1) out.push({ point: b, child: j, interior: false });
      if (stub) continue;
      const q: Point =
        a[0] === b[0]
          ? [a[0], Math.min(Math.max(toward[1], Math.min(a[1], b[1])), Math.max(a[1], b[1]))]
          : [Math.min(Math.max(toward[0], Math.min(a[0], b[0])), Math.max(a[0], b[0])), a[1]];
      if (manhattan(q, a) > 1e-9 && manhattan(q, b) > 1e-9)
        out.push({ point: q, child: j, interior: true });
    }
    return out.sort((u, v) => manhattan(u.point, toward) - manhattan(v.point, toward));
  }
  seal(arrows: readonly Arrow[], paths?: readonly (readonly Point[])[]): Route {
    return {
      x: Float64Array.from(this.x),
      y: Float64Array.from(this.y),
      parent: Int32Array.from(this.parent),
      kind: Uint8Array.from(this.kind),
      stub: Int32Array.from(this.stub),
      arrows,
      ...(paths ? { paths } : {}),
      points: paths ? paths.reduce((n, p) => n + p.length, 0) : this.x.length,
    };
  }
}

/** Route one edge between its visible ends, from the end its flow leaves. */
export function routeEdge(
  edge: Edge,
  ends: readonly End[],
  route: Routing,
  rootIndex: number,
): Route {
  const { options } = route,
    clearance = options.routeClearance,
    arrows = !!edge.options.arrows;
  const preferred = edge.ends[rootIndex],
    root = ends.includes(preferred) ? preferred : ends[0],
    center = (e: End): Point => {
      const n = route.vertex(e.vertex);
      return [n.x + n.width / 2, n.y + n.height / 2];
    };
  const targets = ends.filter((e) => e !== root),
    start = route.end(root, center(targets[0]), arrows),
    readers = targets.map((e) => route.end(e, center(root), arrows)),
    all = [start, ...readers];
  if (typeof edge.options.route === 'object' || edge.options.route === 'straight') {
    const paths =
      typeof edge.options.route === 'object'
        ? edge.options.route.route({
            ends: all,
            obstacles: route.query(
              union(all.map((e) => [...e.position, ...e.position] as Rect)),
              0,
            ),
            clearance,
            signal: route.signal,
          })
        : readers.map((reader) => [start.position, reader.position]);
    if (paths.some((path) => path.some((p) => p.length !== 2 || !p.every(Number.isFinite))))
      throw failure('invalid-input', 'Router returned invalid points');
    const marks: Arrow[] = [],
      drawn = paths.map((path, i) => {
        const end = all[Math.min(i + 1, all.length - 1)];
        return end.arrow ? trim(path, options.portSize, marks) : [...path];
      });
    return new Tree().seal(marks, drawn);
  }
  const tree = new Tree(),
    marks: Arrow[] = [];
  const terminal = (end: Terminal, parent: number) => {
    let tip = end.position;
    if (end.arrow) {
      // An arrowhead fills the last stretch: the wire ends at its base.
      const base: Point = [
        tip[0] + end.normal[0] * options.portSize,
        tip[1] + end.normal[1] * options.portSize,
      ];
      marks.push({ point: tip, direction: [-end.normal[0], -end.normal[1]] });
      tip = base;
    }
    return parent < 0 ? tree.add(tip, -1, 1) : tree.add(tip, parent, 1);
  };
  const origin = terminal(start, -1),
    exit = tree.add(stub(start, route, clearance), origin, 2);
  tree.stub[exit] = origin;
  const order = readers
    .map((reader) => reader)
    .sort((a, b) => manhattan(a.position, start.position) - manhattan(b.position, start.position));
  for (const reader of order) {
    const end = stub(reader, route, clearance),
      path = join(tree, end, reader, start, route, clearance);
    let parent: number;
    if (path.interior) parent = tree.split(path.child, path.points[0]);
    else
      parent =
        manhattan(path.points[0], tree.point(path.child)) < 1e-9
          ? path.child
          : tree.parent[path.child];
    for (let k = 1; k < path.points.length - 1; k++) parent = tree.add(path.points[k], parent);
    const s = tree.add(end, parent, 2);
    tree.stub[s] = terminal(reader, s);
  }
  return tree.seal(marks);
}
/** Where an end's stub ends: clear of its owner by the clearance, or halfway to a neighbor. */
function stub(end: Terminal, route: Routing, clearance: number): Point {
  const own = route.box(end.owner),
    axis = end.normal[0] ? 0 : 1,
    sign = end.normal[axis],
    from = end.arrow ? end.position[axis] + sign * route.options.portSize : end.position[axis];
  const exit = own ? Math.max(0, ((sign > 0 ? own[axis + 2] : own[axis]) - from) * sign) : 0;
  let length = exit + clearance;
  const far = from + sign * length,
    lo = Math.min(from, far),
    hi = Math.max(from, far),
    across = end.position[1 - axis];
  const region: Rect = axis === 0 ? [lo, across, hi, across] : [across, lo, across, hi];
  for (const box of route.query(region, 0)) {
    const near = ((sign > 0 ? box[axis] : box[axis + 2]) - from) * sign;
    if (near > exit + 1e-6 && near < length) length = Math.max(exit + 1, (exit + near) / 2);
  }
  const p: [number, number] = [end.position[0], end.position[1]];
  p[axis] = from + sign * length;
  return p;
}
interface Join {
  readonly points: readonly Point[];
  readonly child: number;
  readonly interior: boolean;
}
/** The cheapest clear way from the tree to a reader's stub end; the shortest elbow without one. */
function join(
  tree: Tree,
  end: Point,
  reader: Terminal,
  root: Terminal,
  route: Routing,
  clearance: number,
): Join {
  const bend = clearance * 2,
    joins = tree.joins(end).slice(0, 8),
    into: Point = [-reader.normal[0], -reader.normal[1]];
  let best: Join | undefined,
    cost = Infinity;
  const consider = (points: readonly Point[], child: number, interior: boolean, check = true) => {
    const path = simplify(points);
    if (!fits(path, into, interior, tree, child)) return;
    let total = (path.length - 2) * bend;
    for (let i = 1; i < path.length; i++) {
      total += manhattan(path[i - 1], path[i]);
      if (total >= cost || (check && !route.clear(path[i - 1], path[i], clearance - 1e-6))) return;
    }
    cost = total;
    best = { points: path, child, interior };
  };
  for (const { point: a, child, interior } of joins) {
    const b = end,
      mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    consider([a, [b[0], a[1]], b], child, interior);
    consider([a, [a[0], b[1]], b], child, interior);
    consider([a, [mx, a[1]], [mx, b[1]], b], child, interior);
    consider([a, [a[0], my], [b[0], my], b], child, interior);
  }
  if (best) return best;
  const owners = [route.box(reader.owner), route.box(root.owner)].filter((box) => !!box) as Rect[];
  for (const by of [clearance, clearance / 2, 0]) {
    for (const { point, child, interior } of joins.slice(0, 3)) {
      const path = search(point, end, owners, route, by, bend);
      if (path) consider(path, child, interior, false);
    }
    if (best) return best;
  }
  const first = joins[0] ?? { point: tree.point(0), child: 1, interior: false };
  return {
    points: simplify([first.point, [end[0], first.point[1]], end]),
    child: first.child,
    interior: first.interior,
  };
}
/**
 * Whether a path from the tree to a reader's stub end turns well: it never doubles back along the
 * stub, and leaves a segment it joins inside across it, not along it.
 */
function fits(
  path: readonly Point[],
  into: Point,
  interior: boolean,
  tree: Tree,
  child: number,
): boolean {
  const n = path.length;
  if (n < 2) return n === 1;
  const a = path[n - 2],
    b = path[n - 1];
  if (Math.sign(b[0] - a[0]) === -into[0] && Math.sign(b[1] - a[1]) === -into[1]) return false;
  const p = tree.point(tree.parent[child]),
    c = tree.point(child);
  if (interior) {
    const along = p[0] === c[0] ? 1 : 0;
    return path[1][along] === path[0][along];
  }
  // At a joint, it leaves along none of the segments already there.
  const d = [Math.sign(path[1][0] - path[0][0]), Math.sign(path[1][1] - path[0][1])],
    joint = manhattan(path[0], p) < 1e-9 ? tree.parent[child] : child;
  for (let k = 0; k < tree.x.length; k++) {
    if (k !== tree.parent[joint] && tree.parent[k] !== joint) continue;
    const q = tree.point(k === tree.parent[joint] ? tree.parent[joint] : k);
    if (Math.sign(q[0] - path[0][0]) === d[0] && Math.sign(q[1] - path[0][1]) === d[1])
      return false;
  }
  return true;
}
/** Points without repeats or in-line middles. */
function simplify(path: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of path) {
    const b = out.at(-1),
      a = out.at(-2);
    if (b && p[0] === b[0] && p[1] === b[1]) continue;
    if (a && b && ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1]))) out.pop();
    out.push(p);
  }
  return out;
}

/** Scratch every search shares; grown, never shrunk. */
let costs = new Float64Array(0),
  from = new Int32Array(0),
  blockedX = new Uint8Array(0),
  blockedY = new Uint8Array(0);
/**
 * The cheapest orthogonal path between two points around obstacles grown by `by`, on the lines
 * their sides make: A* over a local visibility grid whose blocked steps are swept once. Null when
 * either point is inside an obstacle or the window holds no way.
 */
function search(
  a: Point,
  b: Point,
  around: readonly Rect[],
  route: {
    readonly options: Pick<Style, 'routeClearance'>;
    readonly query: Routing['query'];
    readonly signal: AbortSignal;
  },
  by: number,
  bend: number,
): Point[] | null {
  route.signal.throwIfAborted();
  const margin = route.options.routeClearance * 2,
    frame = union([[...a, ...a] as Rect, [...b, ...b] as Rect, ...around]);
  const region: Rect = [frame[0] - margin, frame[1] - margin, frame[2] + margin, frame[3] + margin];
  const boxes = route.query(region, by);
  if (boxes.some((box) => inside(a, box) || inside(b, box))) return null;
  const lines = (axis: 0 | 1) => {
    const values = [a[axis], b[axis], region[axis], region[axis + 2]];
    for (const box of boxes) values.push(box[axis], box[axis + 2]);
    return Float64Array.from(new Set(values)).sort();
  };
  const xs = lines(0),
    ys = lines(1),
    w = xs.length,
    h = ys.length,
    cells = w * h;
  if (cells > 1 << 20) return null;
  if (costs.length < cells * 2) {
    costs = new Float64Array(cells * 2);
    from = new Int32Array(cells * 2);
  }
  if (blockedX.length < cells) {
    blockedX = new Uint8Array(cells);
    blockedY = new Uint8Array(cells);
  }
  costs.fill(Infinity, 0, cells * 2);
  blockedX.fill(0, 0, cells);
  blockedY.fill(0, 0, cells);
  const at = (values: Float64Array, v: number) => {
    let lo = 0,
      hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // A step is blocked inside a box: along rows strictly between its sides, and across columns.
  for (const box of boxes) {
    const x0 = at(xs, box[0]),
      x1 = at(xs, box[2]),
      y0 = at(ys, box[1]),
      y1 = at(ys, box[3]);
    for (let j = y0 + 1; j < y1; j++) blockedX.fill(1, j * w + x0, j * w + x1);
    for (let i = x0 + 1; i < x1; i++) blockedY.fill(1, i * h + y0, i * h + y1);
  }
  const start = at(ys, a[1]) * w + at(xs, a[0]),
    goal = at(ys, b[1]) * w + at(xs, b[0]);
  const heap = new Heap();
  // A state is a cell and the axis of the step that reached it.
  for (const axis of [0, 1]) {
    costs[start * 2 + axis] = 0;
    from[start * 2 + axis] = -1;
    heap.push(start * 2 + axis, manhattan(a, b));
  }
  let visits = 0;
  while (heap.size) {
    const state = heap.pop(),
      cell = state >> 1,
      axis = state & 1,
      cost = costs[state];
    if (cell === goal) {
      const path: Point[] = [];
      for (let s = state; s >= 0; s = from[s]) {
        const c = s >> 1;
        path.push([xs[c % w], ys[Math.floor(c / w)]]);
      }
      return simplify(path.reverse());
    }
    if ((++visits & 1023) === 0) route.signal.throwIfAborted();
    if (visits > 65536) return null;
    const i = cell % w,
      j = (cell - i) / w;
    for (let k = 0; k < 4; k++) {
      const di = k === 0 ? -1 : k === 1 ? 1 : 0,
        dj = k === 2 ? -1 : k === 3 ? 1 : 0,
        ni = i + di,
        nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      if (di ? blockedX[j * w + Math.min(i, ni)] : blockedY[i * h + Math.min(j, nj)]) continue;
      const step = di ? 0 : 1,
        s = (ni + nj * w) * 2 + step,
        value =
          cost +
          Math.abs(xs[ni] - xs[i]) +
          Math.abs(ys[nj] - ys[j]) +
          (from[state] >= 0 && step !== axis ? bend : 0);
      if (value >= costs[s]) continue;
      costs[s] = value;
      from[s] = state;
      heap.push(s, value + Math.abs(b[0] - xs[ni]) + Math.abs(b[1] - ys[nj]));
    }
  }
  return null;
}
/** Connection previews use the same bounded search as routed nets. */
export function orthogonal(
  a: Point,
  b: Point,
  boxes: readonly Rect[],
  clearance: number,
  signal: AbortSignal,
): readonly Point[] {
  signal.throwIfAborted();
  const route = {
    options: { routeClearance: clearance },
    signal,
    query: (region: Rect, by: number) =>
      boxes.filter((box) => intersects(box, region)).map((box) => expand(box, by)),
  };
  return search(a, b, [], route, clearance, clearance * 2) ?? simplify([a, [b[0], a[1]], b]);
}
function inside(p: Point, box: Rect): boolean {
  return (
    p[0] > box[0] + 1e-6 && p[0] < box[2] - 1e-6 && p[1] > box[1] + 1e-6 && p[1] < box[3] - 1e-6
  );
}
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const { ids, keys } = this,
      top = ids[0],
      id = ids.pop()!,
      key = keys.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}
/** End a path an arrowhead short of its tip, and add the arrowhead. */
function trim(path: readonly Point[], length: number, arrows: Arrow[]): Point[] {
  const out = [...path],
    b = out[out.length - 1],
    a = out[out.length - 2];
  if (!a) return out;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!d) return out;
  const u: Point = [(b[0] - a[0]) / d, (b[1] - a[1]) / d],
    cut = Math.min(length, d);
  arrows.push({ point: b, direction: u });
  out[out.length - 1] = [b[0] - u[0] * cut, b[1] - u[1] * cut];
  return out;
}

/** A route as drawn: its paths, each from the root or a branch to a leaf, with marks and bounds. */
export function draw(route: Route, x = route.x, y = route.y): Wire {
  if (route.paths)
    return outline(
      route.paths,
      route.paths.map(() => 0),
      [],
      route.arrows,
    );
  const n = x.length,
    children = new Int32Array(n).fill(-1),
    siblings = new Int32Array(n).fill(-1);
  for (let j = n - 1; j > 0; j--) {
    const parent = route.parent[j];
    if (parent < 0) continue;
    siblings[j] = children[parent];
    children[parent] = j;
  }
  const along = new Float64Array(n),
    paths: Point[][] = [],
    offsets: number[] = [],
    junctions: Point[] = [],
    stack = [0];
  const point = (j: number): Point => [x[j], y[j]];
  while (stack.length) {
    const start = stack.pop()!;
    const firstChild = children[start];
    if (
      firstChild >= 0 &&
      siblings[firstChild] >= 0 &&
      (start !== 0 || siblings[siblings[firstChild]] >= 0)
    )
      junctions.push(point(start));
    for (let first = firstChild; first >= 0; first = siblings[first]) {
      const path: Point[] = [point(start)];
      let prev = start,
        j = first;
      for (;;) {
        along[j] = along[prev] + Math.abs(x[j] - x[prev]) + Math.abs(y[j] - y[prev]);
        path.push(point(j));
        if (children[j] < 0 || siblings[children[j]] >= 0) break;
        prev = j;
        j = children[j];
      }
      paths.push(simplify(path));
      offsets.push(along[start]);
      if (children[j] >= 0) stack.push(j);
    }
  }
  return outline(paths, offsets, junctions, route.arrows);
}
function outline(
  paths: readonly (readonly Point[])[],
  offsets: readonly number[],
  junctions: readonly Point[],
  arrows: readonly Arrow[],
): Wire {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const include = (p: Point) => {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  };
  for (const path of paths) for (const p of path) include(p);
  for (const arrow of arrows) include(arrow.point);
  return {
    paths,
    offsets,
    junctions,
    arrows,
    bounds: minX <= maxX ? [minX, minY, maxX, maxY] : [0, 0, 0, 0],
  };
}

/**
 * Set apart the runs of different nets that share a line: each takes its own track, a grid pitch
 * apart where the corridor between obstacles has room, ordered by where its ends turn so runs
 * nest rather than cross. A run carries its joints, so branches stay joined; ports never move,
 * stubs only grow, and group frames hold their lines like a fixed run.
 */
export function separate(
  routes: readonly (Route | null)[],
  route: Routing,
  frames: readonly Rect[],
): (Wire | null)[] {
  const gap = route.options.gridPitch,
    xs = routes.map((r) => (r && !r.paths ? Float64Array.from(r.x) : null)),
    ys = routes.map((r) => (r && !r.paths ? Float64Array.from(r.y) : null));
  for (const axis of [0, 1] as const) {
    const coords = axis === 0 ? xs : ys,
      other = axis === 0 ? ys : xs;
    const runs = collect(routes, coords, other);
    for (const frame of frames)
      for (const fixed of [frame[axis], frame[axis + 2]])
        runs.push({
          net: -1,
          joints: [],
          fixed,
          lo: frame[1 - axis],
          hi: frame[3 - axis],
          turn: 0,
          low: fixed,
          high: fixed,
        });
    runs.sort((a, b) => a.fixed - b.fixed || a.lo - b.lo);
    for (let i = 0; i < runs.length;) {
      let k = i + 1,
        hi = runs[i].hi;
      while (k < runs.length && runs[k].fixed - runs[i].fixed < 0.5 && runs[k].lo < hi)
        hi = Math.max(hi, runs[k++].hi);
      if (k - i < 2) {
        i = k;
        continue;
      }
      const cluster = runs.slice(i, k),
        line = runs[i].fixed,
        lo = Math.min(...cluster.map((run) => run.lo));
      i = k;
      if (new Set(cluster.map((run) => run.net)).size < 2) continue;
      // The corridor: the free stretch about the line between the nearest obstacles' sides.
      const reach = gap * (cluster.length + 2);
      let low = line - reach,
        high = line + reach;
      for (const box of route.query(
        axis === 0 ? [line - reach, lo, line + reach, hi] : [lo, line - reach, hi, line + reach],
        0,
      )) {
        if (box[axis + 2] <= line + 1e-6) low = Math.max(low, box[axis + 2] + gap / 2);
        else if (box[axis] >= line - 1e-6) high = Math.min(high, box[axis] - gap / 2);
      }
      cluster.sort(
        (a, b) =>
          a.turn - b.turn ||
          (a.turn > 0 ? a.hi - a.lo - (b.hi - b.lo) : b.hi - b.lo - (a.hi - a.lo)) ||
          a.lo - b.lo,
      );
      const fixed = cluster.findIndex((run) => run.low === run.high),
        step = Math.min(gap, Math.max(0, high - low) / Math.max(1, cluster.length - 1));
      let base = fixed >= 0 ? line - fixed * step : line - ((cluster.length - 1) * step) / 2;
      base = Math.max(
        Math.min(low, line),
        Math.min(base, Math.max(high, line) - (cluster.length - 1) * step),
      );
      cluster.forEach((run, order) => {
        if (run.low === run.high) return;
        const at = Math.max(run.low, Math.min(run.high, base + order * step)),
          values = coords[run.net]!;
        for (const j of run.joints) values[j] = at;
      });
    }
  }
  return routes.map((r, net) => (r ? draw(r, xs[net] ?? r.x, ys[net] ?? r.y) : null));
}
interface Run {
  readonly net: number;
  readonly joints: readonly number[];
  readonly fixed: number;
  readonly lo: number;
  readonly hi: number;
  /** Where its ends turn: below zero toward the low side, above toward the high. */
  readonly turn: number;
  /** How far tracks may move it; equal for a run holding a port. */
  readonly low: number;
  readonly high: number;
}
/** Every net's runs on lines of one axis: maximal collinear chains of segments through joints. */
function collect(
  routes: readonly (Route | null)[],
  coords: readonly (Float64Array | null)[],
  other: readonly (Float64Array | null)[],
): Run[] {
  const runs: Run[] = [];
  // Reuse compact adjacency storage across nets instead of allocating arrays per joint.
  let component = new Int32Array(0),
    head = new Int32Array(0),
    neighbor = new Int32Array(0),
    next = new Int32Array(0);
  routes.forEach((route, net) => {
    const c = coords[net],
      o = other[net];
    if (!route || !c || !o) return;
    const n = c.length;
    if (component.length < n) {
      component = new Int32Array(n);
      head = new Int32Array(n);
      neighbor = new Int32Array(n * 2);
      next = new Int32Array(n * 2);
    }
    component.fill(-1, 0, n);
    head.fill(-1, 0, n);
    // Reverse insertion preserves the original ascending segment order at each joint.
    for (let j = n - 1; j > 0; j--) {
      const parent = route.parent[j];
      if (parent < 0) continue;
      const at = j * 2;
      neighbor[at] = parent;
      next[at] = head[j];
      head[j] = at;
      neighbor[at + 1] = j;
      next[at + 1] = head[parent];
      head[parent] = at + 1;
    }
    for (let seed = 0; seed < n; seed++) {
      if (component[seed] >= 0) continue;
      let incident = head[seed];
      while (
        incident >= 0 &&
        (c[seed] !== c[neighbor[incident]] || o[seed] === o[neighbor[incident]])
      )
        incident = next[incident];
      if (incident < 0) continue;
      const joints: number[] = [],
        stack = [seed];
      component[seed] = seed;
      while (stack.length) {
        const j = stack.pop()!;
        joints.push(j);
        for (let at = head[j]; at >= 0; at = next[at]) {
          const k = neighbor[at];
          if (component[k] < 0 && c[j] === c[k] && o[j] !== o[k]) {
            component[k] = seed;
            stack.push(k);
          }
        }
      }
      let lo = Infinity,
        hi = -Infinity,
        first = joints[0],
        last = joints[0],
        low = -Infinity,
        high = Infinity;
      for (const j of joints) {
        if (o[j] < lo) [lo, first] = [o[j], j];
        if (o[j] > hi) [hi, last] = [o[j], j];
        if (route.kind[j] === 1) low = high = c[j];
        else if (route.kind[j] === 2) {
          // A stub only grows: its end stays a marker's length out from its port.
          const port = route.stub[j],
            sign = Math.sign(c[j] - c[port]);
          if (sign > 0) low = Math.max(low, c[port] + 1);
          else if (sign < 0) high = Math.min(high, c[port] - 1);
        }
      }
      const turn = (j: number) => {
        let t = 0;
        for (let at = head[j]; at >= 0; at = next[at]) {
          const k = neighbor[at];
          if (component[k] !== seed) t += Math.sign(c[k] - c[j]);
        }
        return t;
      };
      runs.push({
        net,
        joints,
        fixed: c[seed],
        lo,
        hi,
        turn: turn(first) + turn(last),
        low: Math.min(low, c[seed]),
        high: Math.max(high, c[seed]),
      });
    }
  });
  return runs;
}
