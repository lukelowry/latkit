import { Work, failure } from '@latkit/model';
import { kit, type Point } from '@latkit/gpu';
import type { Scene, Vertex, Rect, Edge, End, Wire } from './scene.js';
import type { DragWire } from './drag.js';
import type { Limits } from './options.js';
import type { Style } from './config.js';
import { rect, union, expand, intersects } from './scene.js';
import { rootEnd } from './layout.js';
import { Routing, obstacles, routeEdge, separate, draw, type Moved, type Route } from './route.js';

export function boundary(
  vertex: Pick<Vertex, 'x' | 'y' | 'width' | 'height' | 'shape' | 'radius'>,
  toward: Point,
): Point {
  const cx = vertex.x + vertex.width / 2,
    cy = vertex.y + vertex.height / 2,
    dx = toward[0] - cx,
    dy = toward[1] - cy;
  const rx = vertex.width / 2,
    ry = vertex.height / 2;
  const factor =
    vertex.shape === 'ellipse'
      ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
      : vertex.shape === 'diamond'
        ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
        : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  if (vertex.shape === 'rounded' && Number.isFinite(factor)) {
    const radius = Math.min(vertex.radius, rx, ry),
      px = dx * factor,
      py = dy * factor;
    if (Math.abs(px) > rx - radius && Math.abs(py) > ry - radius) {
      const x = Math.sign(dx) * (rx - radius),
        y = Math.sign(dy) * (ry - radius),
        a = dx * dx + dy * dy,
        p = dx * x + dy * y;
      const d = p * p - a * (x * x + y * y - radius * radius);
      if (d >= 0) {
        const t = (p + Math.sqrt(d)) / a;
        return [cx + dx * t, cy + dy * t];
      }
    }
  }
  return Number.isFinite(factor) ? [cx + dx * factor, cy + dy * factor] : [cx + rx, cy];
}
export function contains(vertex: Vertex, p: Point): boolean {
  const x = Math.abs((p[0] - vertex.x - vertex.width / 2) / (vertex.width / 2)),
    y = Math.abs((p[1] - vertex.y - vertex.height / 2) / (vertex.height / 2));
  if (vertex.shape === 'rounded') {
    const radius = Math.min(vertex.radius, vertex.width / 2, vertex.height / 2),
      qx = Math.abs(p[0] - vertex.x - vertex.width / 2) - vertex.width / 2 + radius,
      qy = Math.abs(p[1] - vertex.y - vertex.height / 2) - vertex.height / 2 + radius;
    return Math.hypot(Math.max(0, qx), Math.max(0, qy)) + Math.min(Math.max(qx, qy), 0) <= radius;
  }
  return vertex.shape === 'ellipse'
    ? x * x + y * y <= 1
    : vertex.shape === 'diamond'
      ? x + y <= 1
      : x <= 1 && y <= 1;
}
export function distance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
/** Spread each side's ports evenly along it, below a title band. */
export function portPositions(vertex: Vertex): void {
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const ports = vertex.ports
      .filter((p) => p.side === side)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    ports.forEach((p, i) => {
      const t = (i + 1) / (ports.length + 1),
        y = vertex.y + vertex.header + (vertex.height - vertex.header) * t;
      p.position =
        side === 'left'
          ? [vertex.x, y]
          : side === 'right'
            ? [vertex.x + vertex.width, y]
            : side === 'top'
              ? [vertex.x + vertex.width * t, vertex.y]
              : [vertex.x + vertex.width * t, vertex.y + vertex.height];
      p.normal =
        side === 'left' ? [-1, 0] : side === 'right' ? [1, 0] : side === 'top' ? [0, -1] : [0, 1];
      if (vertex.shape === 'ellipse' || vertex.shape === 'diamond')
        p.position = boundary(vertex, p.position);
    });
  }
}
/** Whether an edge draws wires between these ends: two or more, not all inside one collapsed group. */
function routed(edge: Edge, ends: readonly End[], proxy: ReadonlyMap<number, string>): boolean {
  if (!edge.visible || ends.length < 2) return false;
  const first = proxy.get(ends[0].vertex);
  return !first || !ends.every((e) => proxy.get(e.vertex) === first);
}
const key = (edge: Edge) => edge.hit.index.type + '\u0000' + edge.hit.id;

/**
 * Place a scene's ports, frame its groups, and route and label its edges. Edges whose ends and
 * neighbourhood did not change keep their routes from `previous`; tracks are set apart anew.
 */
export async function geometry(
  scene: Scene,
  options: Style,
  limits: Required<Limits>,
  signal: AbortSignal,
  previous?: Scene,
  work: Work = new Work(signal, limits.layoutMs),
): Promise<void> {
  scene.portSize = options.portSize;
  scene.bytes -= scene.routeBytes;
  scene.routeBytes = 0;
  for (const vertex of scene.vertices) {
    vertex.visible = vertex.sourceVisible;
    portPositions(vertex);
  }
  const groups = new Map(scene.groups.map((g) => [g.id, g]));
  const depth = (id: string): number => {
    let n = 0;
    for (let p = groups.get(id)?.parent; p; p = groups.get(p)?.parent) n++;
    return n;
  };
  const pad = options.vertexPadding;
  for (const group of [...scene.groups].sort((a, b) => depth(b.id) - depth(a.id))) {
    const boxes = group.members
      .filter((i) => scene.vertices[i].visible)
      .map((i) => rect(scene.vertices[i]));
    for (const child of scene.groups)
      if (child.parent === group.id && child.bounds[0] !== child.bounds[2])
        boxes.push(child.bounds);
    let box = boxes.length ? expand(union(boxes), pad) : ([0, 0, 0, 0] as Rect);
    if (boxes.length) box = [box[0], box[1] - group.header, box[2], box[3]];
    if (group.collapsed)
      box = [
        box[0],
        box[1],
        box[0] + Math.max(120, group.label.width + pad * 2),
        box[1] + Math.max(group.header + pad * 2, 56),
      ];
    group.bounds = box;
  }
  const hidden = new Set<number>(),
    hiddenGroups = new Set<string>();
  for (let i = 0; i < scene.vertices.length; i++)
    for (let g = scene.vertices[i].group; g; g = groups.get(g)?.parent)
      if (groups.get(g)?.collapsed) hidden.add(i);
  for (const group of scene.groups)
    for (let p = group.parent; p; p = groups.get(p)?.parent)
      if (groups.get(p)?.collapsed) hiddenGroups.add(group.id);
  for (const id of hiddenGroups) groups.get(id)!.bounds = [0, 0, 0, 0];
  scene.obstacles = obstacles(scene, hidden);
  const route = new Routing(scene, options, signal),
    proxy = scene.obstacles.proxy;
  // Which old routes still hold: an edge keeps its route unless an end or a box near it moved.
  const old = new Map(previous?.edges.map((e) => [key(e), e]));
  const changed = new Set<number>(),
    boxes: Rect[] = [];
  scene.vertices.forEach((n, i) => {
    const p = previous?.vertices[i];
    if (
      !p ||
      n.hit.id !== p.hit.id ||
      n.hit.index.type !== p.hit.index.type ||
      n.visible !== p.visible ||
      n.x !== p.x ||
      n.y !== p.y ||
      n.width !== p.width ||
      n.height !== p.height ||
      n.shape !== p.shape ||
      n.radius !== p.radius ||
      n.ports.length !== p.ports.length ||
      n.ports.some((port, j) => {
        const before = p.ports[j];
        return (
          port.name !== before.name ||
          port.position[0] !== before.position[0] ||
          port.position[1] !== before.position[1] ||
          port.normal[0] !== before.normal[0] ||
          port.normal[1] !== before.normal[1]
        );
      })
    ) {
      changed.add(i);
      boxes.push(expand(rect(n), options.routeClearance * 2));
      if (p) boxes.push(expand(rect(p), options.routeClearance * 2));
    }
  });
  const sameGroups =
    !!previous &&
    scene.groups.length === previous.groups.length &&
    scene.groups.every(
      (g, i) =>
        g.id === previous.groups[i].id &&
        g.collapsed === previous.groups[i].collapsed &&
        g.bounds.every((v, j) => v === previous.groups[i].bounds[j]),
    );
  const affected = new Set<string>();
  if (previous && boxes.length && previous.edges.length) {
    const near = kit.BoxIndex.of(previous.edges.length, union(boxes), (i, box) =>
      box.set(expand(previous.edges[i].bounds, options.routeClearance)),
    );
    for (const box of boxes)
      for (const i of near.query(box)) {
        const edge = previous.edges[i];
        if (intersects(expand(edge.bounds, options.routeClearance), box)) affected.add(key(edge));
      }
  }
  const reuse =
    sameGroups &&
    previous?.routeClearance === options.routeClearance &&
    previous.portSize === options.portSize;
  const routes: (Route | null)[] = [];
  let points = 0;
  for (const edge of scene.edges) {
    await work.step();
    const ends = edge.ends.filter((e) => scene.vertices[e.vertex].visible);
    let result: Route | null = null;
    if (routed(edge, ends, proxy)) {
      const before = old.get(key(edge));
      result =
        reuse &&
        before?.route &&
        !edge.ends.some((e) => changed.has(e.vertex)) &&
        !affected.has(key(edge)) &&
        before.options.route === edge.options.route &&
        before.options.arrows === edge.options.arrows &&
        before.options.appearance === edge.options.appearance &&
        sameEnds(before.ends, edge.ends)
          ? before.route
          : routeEdge(edge, ends, route, rootEnd(edge));
      points += result.points;
      if (points > limits.routePoints) throw failure('resource-limit', 'Too many route points');
    }
    edge.route = result;
    routes.push(result);
  }
  const frames = scene.groups
    .filter((g) => !g.collapsed && g.bounds[0] !== g.bounds[2])
    .map((g) => g.bounds);
  const wires = separate(
    routes.map((r, i) => (scene.edges[i].options.appearance === 'tag' ? null : r)),
    route,
    frames,
  );
  scene.edges.forEach((edge, i) => {
    const r = routes[i],
      wire = r && edge.options.appearance === 'tag' ? tag(r) : wires[i];
    edge.paths = wire?.paths ?? [];
    edge.offsets = wire?.offsets ?? [];
    edge.junctions = wire?.junctions ?? [];
    edge.arrows = wire?.arrows ?? [];
    edge.bounds = wire?.bounds ?? [0, 0, 0, 0];
  });
  label(scene, options, hidden);
  for (const i of hidden) scene.vertices[i].visible = false;
  scene.bounds = union([
    ...scene.vertices.filter((n) => n.visible).map(rect),
    ...scene.edges.filter((e) => e.visible && e.paths.length).map((e) => e.bounds),
    ...scene.groups.filter((g) => g.bounds[0] !== g.bounds[2]).map((g) => g.bounds),
  ]);
  scene.routeClearance = options.routeClearance;
  scene.routeBytes = points * 24 + scene.obstacles.index.bytes + scene.obstacles.boxes.byteLength;
  scene.bytes += scene.routeBytes;
  work.check();
  if (scene.bytes > limits.geometryBytes)
    throw failure('resource-limit', 'Route geometry exceeds budget');
}
function sameEnds(a: readonly End[], b: readonly End[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) => e.vertex === b[i].vertex && e.port === b[i].port && e.direction === b[i].direction,
    )
  );
}
/** A tag edge draws only each end's stub, out from its port; its label names the net at each. */
function tag(route: Route): Wire {
  const wire = draw(route);
  if (route.paths) return wire;
  const stubs: Point[][] = [];
  for (let j = 0; j < route.x.length; j++) {
    if (route.kind[j] !== 1) continue;
    const out = route.parent[j] >= 0 ? route.parent[j] : route.parent.indexOf(j);
    if (out >= 0)
      stubs.push([
        [route.x[j], route.y[j]],
        [route.x[out], route.y[out]],
      ]);
  }
  return { ...wire, paths: stubs, offsets: stubs.map(() => 0), junctions: [] };
}
/** Room kept between a label and its wire, and around its text inside its pill. */
const GAP = 4,
  MARGIN = 3;
/** The pill a label at this top-left fills. */
export function labelBox(edge: Edge, at: Point): Rect {
  return [
    at[0] - MARGIN,
    at[1] - MARGIN,
    at[0] + edge.label.width + MARGIN,
    at[1] + edge.label.height + MARGIN,
  ];
}
/**
 * Where an edge's label may go, best first: above its longest level runs, then below them, then
 * beside its longest upright runs; a tag's past the end of each stub.
 */
function spots(edge: Edge, paths: readonly (readonly Point[])[]): Point[][] {
  const { width, height } = edge.label;
  if (edge.options.appearance === 'tag')
    return [
      paths.map(([a, b]) =>
        b[0] >= a[0] ? [b[0] + GAP, b[1] - height / 2] : [b[0] - GAP - width, b[1] - height / 2],
      ),
    ];
  return paths
    .flatMap((path) => path.slice(1).map((b, i) => [path[i], b] as const))
    .map(([a, b]) => ({
      a,
      b,
      level: a[1] === b[1],
      length: Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]),
    }))
    .sort((u, v) => +v.level - +u.level || v.length - u.length)
    .slice(0, 4)
    .flatMap(({ a, b, level }): Point[][] => {
      const mx = (a[0] + b[0]) / 2,
        my = (a[1] + b[1]) / 2;
      return level
        ? [[[mx - width / 2, my - GAP - MARGIN - height]], [[mx - width / 2, my + GAP + MARGIN]]]
        : [[[mx + GAP + MARGIN, my - height / 2]], [[mx - GAP - MARGIN - width, my - height / 2]]];
    });
}
/** Place each edge's label at its best spot nothing placed overlaps, else at its best spot. */
function label(scene: Scene, options: Style, hidden: ReadonlySet<number>): void {
  const placed = new kit.Occupancy(64);
  scene.vertices.forEach((vertex, i) => {
    if (vertex.visible && !hidden.has(i)) placed.add(rect(vertex));
  });
  for (const edge of scene.edges) {
    edge.labels = [];
    if (!edge.visible || !options.labels || !edge.label.runs.length || !edge.paths.length) continue;
    const choices = spots(edge, edge.paths),
      chosen =
        choices.find((points) => points.every((p) => placed.free(labelBox(edge, p)))) ?? choices[0];
    for (const p of chosen) placed.add(labelBox(edge, p));
    edge.labels = chosen;
    edge.bounds = union([edge.bounds, ...chosen.map((p) => labelBox(edge, p))]);
  }
}
/** The wires a drag reroutes: each edge touching what moves, routed where it is going. */
export function dragWires(
  scene: Scene,
  edges: readonly number[],
  moved: Moved,
  options: Style,
  signal: AbortSignal,
): DragWire[] {
  const route = new Routing(scene, options, signal, moved),
    proxy = scene.obstacles!.proxy,
    out: DragWire[] = [];
  for (const i of edges) {
    const edge = scene.edges[i],
      ends = edge.ends.filter((e) => scene.vertices[e.vertex].sourceVisible);
    if (!routed(edge, ends, proxy)) continue;
    const r = routeEdge(edge, ends, route, rootEnd(edge));
    const wire = edge.options.appearance === 'tag' ? tag(r) : draw(r),
      labels = options.labels && edge.label.runs.length ? (spots(edge, wire.paths)[0] ?? []) : [];
    out.push({ ...wire, edge, slot: scene.slots.edges + i, labels });
  }
  return out;
}
