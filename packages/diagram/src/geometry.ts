import { Work, failure } from '@latkit/model';
import { kit, type Point, type TextAlign, type TextBaseline } from '@latkit/gpu';
import type { Scene, Vertex, Rect, Edge, End, Wire, Part } from './scene.js';
import type { DragWire } from './drag.js';
import type { Limits } from './options.js';
import type { Style } from './config.js';
import { rect, union, expand, groupFrame, sceneKey } from './scene.js';
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
/** The style a scene's routes and labels were made with; another one routes everything again. */
function routing(options: Style): string {
  return [options.routeClearance, options.portSize, options.gridPitch, +options.labels].join();
}

/**
 * Place a scene's ports, frame its groups, and route and label its edges, part by part. A part
 * that did not change keeps its wires and labels from `previous`; in one that did, edges whose ends
 * and neighbourhood did not change keep their routes, and tracks and labels are placed anew.
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
  for (const group of [...scene.groups].sort((a, b) => depth(b.id) - depth(a.id))) {
    const boxes = group.members
      .filter((i) => scene.vertices[i].visible)
      .map((i) => rect(scene.vertices[i]));
    for (const child of scene.groups)
      if (child.parent === group.id && child.bounds[0] !== child.bounds[2])
        boxes.push(child.bounds);
    group.bounds = boxes.length
      ? groupFrame(union(boxes), group, options.vertexPadding)
      : [0, 0, 0, 0];
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
    kept = previous?.routing === routing(options) ? new Kept(scene, previous, options) : undefined;
  for (const edge of scene.edges) clear(edge);
  let points = 0;
  for (const part of scene.parts) {
    await work.step();
    const old = kept?.part(part);
    if (old) adopt(scene, part, previous!, old);
    else {
      const routes: (Route | null)[] = [];
      for (const e of part.edges) {
        await work.step();
        const edge = scene.edges[e],
          ends = edge.ends.filter((end) => scene.vertices[end.vertex].visible);
        edge.route = routed(edge, ends, scene.obstacles.proxy)
          ? (kept?.route(edge) ?? routeEdge(edge, ends, route, rootEnd(edge)))
          : null;
        routes.push(edge.route);
      }
      const frames = part.groups
        .map((g) => scene.groups[g])
        .filter((g) => !g.collapsed && g.bounds[0] !== g.bounds[2])
        .map((g) => g.bounds);
      const wires = separate(
        routes.map((r, k) => (scene.edges[part.edges[k]].options.appearance === 'tag' ? null : r)),
        route,
        frames,
      );
      part.edges.forEach((e, k) => {
        const edge = scene.edges[e],
          r = routes[k];
        if (r) Object.assign(edge, edge.options.appearance === 'tag' ? tag(r) : wires[k]);
      });
      label(scene, part, options, route);
    }
    for (const e of part.edges) points += scene.edges[e].route?.points ?? 0;
    if (points > limits.routePoints) throw failure('resource-limit', 'Too many route points');
  }
  for (const i of hidden) scene.vertices[i].visible = false;
  scene.bounds = union([
    ...scene.vertices.filter((n) => n.visible).map(rect),
    ...scene.edges.filter((e) => e.visible && e.paths.length).map((e) => e.bounds),
    ...scene.groups.filter((g) => g.bounds[0] !== g.bounds[2]).map((g) => g.bounds),
  ]);
  scene.routing = routing(options);
  scene.routeBytes = points * 24 + scene.obstacles.index.bytes + scene.obstacles.boxes.byteLength;
  scene.bytes += scene.routeBytes;
  work.check();
  if (scene.bytes > limits.geometryBytes)
    throw failure('resource-limit', 'Route geometry exceeds budget');
}
/** An edge with nothing drawn. */
function clear(edge: Edge): void {
  edge.route = null;
  edge.paths = [];
  edge.offsets = [];
  edge.junctions = [];
  edge.arrows = [];
  edge.bounds = [0, 0, 0, 0];
  edge.labels = [];
}
/** An unchanged part's wires and labels, as the previous scene drew them. */
function adopt(scene: Scene, part: Part, previous: Scene, old: Part): void {
  part.edges.forEach((e, k) => {
    const { route, paths, offsets, junctions, arrows, bounds, labels } =
      previous.edges[old.edges[k]];
    Object.assign(scene.edges[e], { route, paths, offsets, junctions, arrows, bounds, labels });
  });
}
/** What of the previous scene still holds: its vertices by key, and what moved since. */
class Kept {
  /** Each vertex's index in the previous scene; -1 when new. */
  private readonly was: Int32Array;
  private readonly changed: Uint8Array;
  /** Previous edges near anything that moved, by key. */
  private readonly affected = new Set<string>();
  private readonly edges: Map<string, Edge>;
  private readonly parts: Map<string, Part>;
  /** Whether every group frames and hides what it did, so proxies route as they did. */
  private readonly groups: boolean;
  constructor(
    private readonly scene: Scene,
    private readonly previous: Scene,
    options: Style,
  ) {
    this.groups =
      scene.groups.length === previous.groups.length &&
      scene.groups.every((group, i) => {
        const before = previous.groups[i];
        return (
          group.id === before.id &&
          group.collapsed === before.collapsed &&
          group.bounds.every((v, j) => v === before.bounds[j])
        );
      });
    const prior = new Map(previous.vertices.map((vertex, i) => [sceneKey(vertex.hit), i])),
      seen = new Uint8Array(previous.vertices.length),
      by = options.routeClearance * 2,
      moved: Rect[] = [];
    this.was = new Int32Array(scene.vertices.length);
    this.changed = new Uint8Array(scene.vertices.length);
    scene.vertices.forEach((vertex, i) => {
      const at = prior.get(sceneKey(vertex.hit)) ?? -1,
        before = previous.vertices[at];
      this.was[i] = at;
      if (at >= 0) seen[at] = 1;
      if (before && sameVertex(vertex, before)) return;
      this.changed[i] = 1;
      moved.push(expand(rect(vertex), by));
      if (before) moved.push(expand(rect(before), by));
    });
    previous.vertices.forEach((vertex, i) => {
      if (!seen[i]) moved.push(expand(rect(vertex), by));
    });
    if (moved.length && previous.edges.length) {
      const near = kit.BoxIndex.of(previous.edges.length, union(moved), (i, box) =>
        box.set(expand(previous.edges[i].bounds, options.routeClearance)),
      );
      for (const box of moved)
        near.some(box, (i) => {
          this.affected.add(sceneKey(previous.edges[i].hit));
        });
    }
    this.edges = new Map(previous.edges.map((edge) => [sceneKey(edge.hit), edge]));
    this.parts = new Map(previous.parts.map((part) => [part.key, part]));
  }
  /** The previous route of an edge whose ends and neighbourhood did not change. */
  route(edge: Edge): Route | undefined {
    const before = this.edges.get(sceneKey(edge.hit));
    return this.groups &&
      before?.route &&
      this.same(edge, before) &&
      !edge.ends.some((end) => this.changed[end.vertex])
      ? before.route
      : undefined;
  }
  /** The previous part, when nothing in it or near it changed. */
  part(part: Part): Part | undefined {
    const { scene, previous } = this,
      old = this.parts.get(part.key);
    if (
      !old ||
      old.vertices.length !== part.vertices.length ||
      old.edges.length !== part.edges.length ||
      old.groups.length !== part.groups.length ||
      part.vertices.some((v, k) => this.changed[v] || this.was[v] !== old.vertices[k]) ||
      part.edges.some((e, k) => {
        const edge = scene.edges[e],
          before = previous.edges[old.edges[k]];
        return sceneKey(edge.hit) !== sceneKey(before.hit) || !this.same(edge, before);
      }) ||
      part.groups.some((g, k) => {
        const group = scene.groups[g],
          before = previous.groups[old.groups[k]];
        return (
          group.id !== before.id ||
          group.collapsed !== before.collapsed ||
          group.bounds.some((v, i) => v !== before.bounds[i])
        );
      })
    )
      return undefined;
    return old;
  }
  /** Whether an edge draws as it did: the same ends, options, and label, and nothing moved near it. */
  private same(edge: Edge, before: Edge): boolean {
    return (
      edge.visible === before.visible &&
      edge.options.route === before.options.route &&
      edge.options.arrows === before.options.arrows &&
      edge.options.appearance === before.options.appearance &&
      edge.label.width === before.label.width &&
      edge.label.height === before.label.height &&
      edge.ends.length === before.ends.length &&
      edge.ends.every(
        (end, i) =>
          this.was[end.vertex] === before.ends[i].vertex &&
          end.port === before.ends[i].port &&
          end.direction === before.ends[i].direction,
      ) &&
      !this.affected.has(sceneKey(edge.hit))
    );
  }
}
/** Whether a vertex routes as it did: the same box, shape, visibility, and ports. */
function sameVertex(a: Vertex, b: Vertex): boolean {
  return (
    a.sourceVisible === b.sourceVisible &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.shape === b.shape &&
    a.radius === b.radius &&
    a.ports.length === b.ports.length &&
    a.ports.every((port, j) => {
      const before = b.ports[j];
      return (
        port.name === before.name &&
        port.position[0] === before.position[0] &&
        port.position[1] === before.position[1] &&
        port.normal[0] === before.normal[0] &&
        port.normal[1] === before.normal[1]
      );
    })
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
/** The pill a label with its origin here fills: its text's box and margin. */
export function labelBox(edge: Edge, at: Point): Rect {
  return kit.textBox(edge.label, at, MARGIN);
}
/**
 * The room an edge's labels take between its ends, for layout to keep: its wire's label, or a
 * tag's past the stub at each end.
 */
export function labelRoom(edge: Edge, options: Style): Point {
  const { width, height, runs } = edge.label;
  if (!options.labels || !runs.length) return [0, 0];
  if (edge.options.appearance !== 'tag') return [width, height];
  const stub = options.routeClearance + GAP + MARGIN * 2;
  return [(width + stub) * 2, (height + stub) * 2];
}
/** How many steps a label may slide each way from a run's middle: half its length, or a quarter of the run. */
const SLIDES = 16;
/**
 * Where an edge's label may go, best first: above or below the middle of its longest level runs,
 * else beside its longest upright runs, then sliding out along them; a tag's past each stub.
 */
function spots(edge: Edge, paths: readonly (readonly Point[])[]): Point[][] {
  const text = edge.label,
    at = (x: number, y: number, align: TextAlign, baseline: TextBaseline) =>
      kit.textOrigin(text, [x, y], align, baseline);
  if (edge.options.appearance === 'tag')
    return [
      paths.map(([a, b]) =>
        b[0] >= a[0]
          ? at(b[0] + GAP + MARGIN, b[1], 'start', 'middle')
          : at(b[0] - GAP - MARGIN, b[1], 'end', 'middle'),
      ),
    ];
  const runs = paths
    .flatMap((path) => path.slice(1).map((b, i) => [path[i], b] as const))
    .map(([a, b]) => ({
      a,
      b,
      level: a[1] === b[1],
      length: Math.hypot(b[0] - a[0], b[1] - a[1]),
    }))
    .sort((u, v) => +v.level - +u.level || v.length - u.length)
    .slice(0, 4);
  const out: Point[][] = [];
  for (let k = 0; k <= SLIDES; k++)
    for (const { a, b, level, length } of runs) {
      const step = Math.min((level ? text.width : text.height) / 2 + MARGIN, length / 4),
        reach = k ? (k * step) / length : 0;
      if (k && !(step > 0 && reach <= 0.5)) continue;
      for (const t of k ? [0.5 - reach, 0.5 + reach] : [0.5]) {
        const x = a[0] + (b[0] - a[0]) * t,
          y = a[1] + (b[1] - a[1]) * t;
        if (level)
          out.push(
            [at(x, y - GAP - MARGIN, 'center', 'bottom')],
            [at(x, y + GAP + MARGIN, 'center', 'top')],
          );
        else
          out.push(
            [at(x + GAP + MARGIN, y, 'start', 'middle')],
            [at(x - GAP - MARGIN, y, 'end', 'middle')],
          );
      }
    }
  return out;
}
/**
 * Place each label of a part at its best spot clear of blocks and its other labels, else clear of
 * blocks, else at its best spot.
 */
function label(scene: Scene, part: Part, options: Style, route: Routing): void {
  const placed = new kit.Occupancy(64),
    clear = (box: Rect) => !route.some(box, 0, () => true),
    free = (box: Rect) => placed.free(box) && clear(box);
  for (const e of part.edges) {
    const edge = scene.edges[e];
    edge.labels = [];
    if (!edge.visible || !options.labels || !edge.label.runs.length || !edge.paths.length) continue;
    const choices = spots(edge, edge.paths),
      chosen =
        choices.find((points) => points.every((p) => free(labelBox(edge, p)))) ??
        choices.find((points) => points.every((p) => clear(labelBox(edge, p)))) ??
        choices[0];
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
