import { failure } from '@latkit/model';
import { kit } from '@latkit/gpu';
import type { Point, RouteEnd } from './data.js';
import type { Scene, Vertex, Rect, End } from './scene.js';
import type { Limits } from './options.js';
import type { Style } from './config.js';
import { rect } from './scene.js';
import { SpatialIndex, union, expand } from './spatial.js';
import { rootEnd } from './layout.js';

export function boundary(vertex: Vertex, toward: Point): Point {
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
export function portPositions(vertex: Vertex): void {
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const ports = vertex.ports
      .filter((p) => p.side === side)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    ports.forEach((p, i) => {
      const t = (i + 1) / (ports.length + 1);
      p.position =
        side === 'left'
          ? [vertex.x, vertex.y + vertex.header + (vertex.height - vertex.header) * t]
          : side === 'right'
            ? [
                vertex.x + vertex.width,
                vertex.y + vertex.header + (vertex.height - vertex.header) * t,
              ]
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
function blocked(a: Point, b: Point, box: Rect): boolean {
  if (a[0] === b[0])
    return (
      a[0] > box[0] + 1e-6 &&
      a[0] < box[2] - 1e-6 &&
      Math.max(a[1], b[1]) > box[1] + 1e-6 &&
      Math.min(a[1], b[1]) < box[3] - 1e-6
    );
  return (
    a[1] > box[1] + 1e-6 &&
    a[1] < box[3] - 1e-6 &&
    Math.max(a[0], b[0]) > box[0] + 1e-6 &&
    Math.min(a[0], b[0]) < box[2] - 1e-6
  );
}
class Heap {
  private items: { id: number; cost: number }[] = [];
  push(id: number, cost: number) {
    let i = this.items.length;
    this.items.push({ id, cost });
    while (i) {
      const p = (i - 1) >> 1;
      if (this.items[p].cost <= cost) break;
      this.items[i] = this.items[p];
      i = p;
    }
    this.items[i] = { id, cost };
  }
  pop(): { id: number; cost: number } | undefined {
    const first = this.items[0],
      last = this.items.pop();
    if (!this.items.length || !last) return first;
    let i = 0;
    while (i * 2 + 1 < this.items.length) {
      let j = i * 2 + 1;
      if (j + 1 < this.items.length && this.items[j + 1].cost < this.items[j].cost) j++;
      if (this.items[j].cost >= last.cost) break;
      this.items[i] = this.items[j];
      i = j;
    }
    this.items[i] = last;
    return first;
  }
}
export function orthogonal(
  a: Point,
  b: Point,
  obstacles: readonly Rect[],
  clearance: number,
  signal: AbortSignal,
): readonly Point[] {
  const clear = (p: readonly Point[]) =>
    p.slice(1).every((q, i) => !obstacles.some((r) => blocked(p[i], q, r)));
  const candidates: Point[][] = [
    [a, [b[0], a[1]], b],
    [a, [a[0], b[1]], b],
    [a, [(a[0] + b[0]) / 2, a[1]], [(a[0] + b[0]) / 2, b[1]], b],
  ];
  for (const p of candidates) if (clear(p)) return simplify(p);
  // Sparse rectilinear visibility grid; A* visits only needed intersections.
  const xs = new Set([a[0], b[0]]),
    ys = new Set([a[1], b[1]]);
  for (const box of obstacles) {
    xs.add(box[0]);
    xs.add(box[2]);
    ys.add(box[1]);
    ys.add(box[3]);
  }
  xs.add(Math.min(a[0], b[0], ...obstacles.map((r) => r[0])) - clearance);
  xs.add(Math.max(a[0], b[0], ...obstacles.map((r) => r[2])) + clearance);
  ys.add(Math.min(a[1], b[1], ...obstacles.map((r) => r[1])) - clearance);
  ys.add(Math.max(a[1], b[1], ...obstacles.map((r) => r[3])) + clearance);
  const x = [...xs].sort((a, b) => a - b),
    y = [...ys].sort((a, b) => a - b),
    width = x.length;
  const start = y.indexOf(a[1]) * width + x.indexOf(a[0]),
    end = y.indexOf(b[1]) * width + x.indexOf(b[0]);
  const heap = new Heap(),
    costs = new Map<number, number>([[start * 3, 0]]),
    prev = new Map<number, number>();
  heap.push(start * 3, 0);
  let visits = 0;
  for (let current = heap.pop(); current; current = heap.pop()) {
    if ((visits++ & 63) === 0) signal.throwIfAborted();
    if (visits > 32768) throw failure('resource-limit', 'Orthogonal route search exceeded budget');
    const id = current.id,
      cost = costs.get(id)!;
    const vertex = Math.floor(id / 3),
      direction = id % 3;
    if (vertex === end) {
      const path: Point[] = [];
      for (let at: number | undefined = id; at !== undefined; at = prev.get(at))
        path.push([x[Math.floor(at / 3) % width], y[Math.floor(Math.floor(at / 3) / width)]]);
      return simplify(path.reverse());
    }
    const ix = vertex % width,
      iy = Math.floor(vertex / width),
      p: Point = [x[ix], y[iy]];
    for (const [nx, ny] of [
      [ix - 1, iy],
      [ix + 1, iy],
      [ix, iy - 1],
      [ix, iy + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= y.length) continue;
      const q: Point = [x[nx], y[ny]],
        axis = nx === ix ? 2 : 1,
        nid = (ny * width + nx) * 3 + axis;
      if (obstacles.some((r) => blocked(p, q, r))) continue;
      const next =
        cost +
        Math.abs(q[0] - p[0]) +
        Math.abs(q[1] - p[1]) +
        (direction && direction !== axis ? clearance : 0);
      if (next >= (costs.get(nid) ?? Infinity)) continue;
      costs.set(nid, next);
      prev.set(nid, id);
      heap.push(nid, next + Math.abs(b[0] - q[0]) + Math.abs(b[1] - q[1]));
    }
  }
  throw failure('invalid-input', 'No orthogonal route between the specified ends');
}
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
/** Merge shared trunks while retaining distance and direction from each route's root. */
function segments(paths: readonly (readonly Point[])[]): {
  paths: Point[][];
  offsets: number[];
  junctions: Point[];
} {
  type Part = { start: number; end: number; offset: number };
  const lines = new Map<string, { axis: number; fixed: number; parts: Part[] }>(),
    out: Point[][] = [],
    offsets: number[] = [];
  for (const path of paths) {
    let offset = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        b = path[i],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      if (a[0] !== b[0] && a[1] !== b[1]) {
        out.push([a, b]);
        offsets.push(offset);
      } else {
        const axis = a[0] === b[0] ? 1 : 0,
          fixed = a[1 - axis],
          key = axis + ':' + fixed;
        const line = lines.get(key) ?? { axis, fixed, parts: [] };
        line.parts.push({ start: a[axis], end: b[axis], offset });
        lines.set(key, line);
      }
      offset += length;
    }
  }
  for (const line of lines.values()) {
    const events = new Map<number, { add: Part[]; remove: Part[] }>();
    const event = (at: number) => {
      let value = events.get(at);
      if (!value) {
        value = { add: [], remove: [] };
        events.set(at, value);
      }
      return value;
    };
    for (const part of line.parts) {
      event(Math.min(part.start, part.end)).add.push(part);
      event(Math.max(part.start, part.end)).remove.push(part);
    }
    const points = [...events.keys()].sort((a, b) => a - b),
      active = new Set<Part>();
    for (let i = 0; i < points.length - 1; i++) {
      const value = events.get(points[i])!;
      for (const part of value.remove) active.delete(part);
      for (const part of value.add) active.add(part);
      let chosen: Part | undefined,
        distance = Infinity;
      for (const part of active) {
        const start = part.start < part.end ? points[i] : points[i + 1];
        const next = part.offset + Math.abs(start - part.start);
        if (next < distance) {
          chosen = part;
          distance = next;
        }
      }
      if (!chosen) continue;
      const a = chosen.start < chosen.end ? points[i] : points[i + 1];
      const b = chosen.start < chosen.end ? points[i + 1] : points[i];
      out.push(
        line.axis === 0
          ? [
              [a, line.fixed],
              [b, line.fixed],
            ]
          : [
              [line.fixed, a],
              [line.fixed, b],
            ],
      );
      offsets.push(distance);
    }
  }
  const degree = new Map<string, { p: Point; n: number }>();
  for (const path of out)
    for (const p of path) {
      const key = p.join(','),
        value = degree.get(key) ?? { p, n: 0 };
      value.n++;
      degree.set(key, value);
    }
  return {
    paths: out,
    offsets,
    junctions: [...degree.values()].filter((v) => v.n >= 3).map((v) => v.p),
  };
}

export async function geometry(
  scene: Scene,
  options: Style,
  limits: Required<Limits>,
  signal: AbortSignal,
  previous?: Scene,
  work: kit.Work = new kit.Work(signal, limits.layoutMs),
): Promise<void> {
  scene.portSizePx = options.portSizePx;
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
  const hidden = new Set<number>(),
    hiddenGroups = new Set<string>();
  for (const group of [...scene.groups].sort((a, b) => depth(b.id) - depth(a.id))) {
    const boxes = group.members
      .filter((i) => scene.vertices[i].visible)
      .map((i) => rect(scene.vertices[i]));
    for (const child of scene.groups) if (child.parent === group.id) boxes.push(child.bounds);
    let box = expand(union(boxes), options.vertexPadding);
    box = [box[0], box[1] - group.label.height - options.vertexPadding, box[2], box[3]];
    if (group.collapsed)
      box = [
        box[0],
        box[1],
        box[0] + Math.max(120, group.label.width + options.vertexPadding * 2),
        box[1] + Math.max(56, group.label.height + options.vertexPadding * 2),
      ];
    group.bounds = box;
  }
  const proxy = new Map<number, string>();
  for (let i = 0; i < scene.vertices.length; i++) {
    let group = scene.vertices[i].group,
      collapsed: string | undefined;
    while (group) {
      if (groups.get(group)?.collapsed) collapsed = group;
      group = groups.get(group)?.parent;
    }
    if (collapsed) {
      hidden.add(i);
      proxy.set(i, collapsed);
    }
  }
  for (const group of scene.groups) {
    let parent = group.parent;
    while (parent) {
      if (groups.get(parent)?.collapsed) hiddenGroups.add(group.id);
      parent = groups.get(parent)?.parent;
    }
  }
  const obstacles = new SpatialIndex(limits.pickingBytes),
    owners: number[] = [];
  scene.vertices.forEach((vertex, i) => {
    if (vertex.visible && !hidden.has(i)) {
      obstacles.add(expand(rect(vertex), 2));
      owners.push(i);
    }
  });
  const proxyOwner = new Map<string, number>();
  for (const group of scene.groups)
    if (group.collapsed && !hiddenGroups.has(group.id)) {
      proxyOwner.set(group.id, scene.vertices.length + proxyOwner.size);
      obstacles.add(expand(group.bounds, 2));
      owners.push(proxyOwner.get(group.id)!);
    }
  const ownerBounds = new Map(owners.map((owner, i) => [owner, obstacles.boxes[i]]));
  const routeEnd = (e: End, toward: Point): RouteEnd & { owner: number } => {
    const vertex = scene.vertices[e.vertex],
      group = proxy.get(e.vertex),
      g = group && groups.get(group);
    if (g) {
      const box = g.bounds,
        n = {
          ...vertex,
          x: box[0],
          y: box[1],
          width: box[2] - box[0],
          height: box[3] - box[1],
          shape: 'rectangle' as const,
        },
        p = boundary(n, toward),
        dx = p[0] - (n.x + n.width / 2),
        dy = p[1] - (n.y + n.height / 2);
      return {
        position: p,
        normal:
          Math.abs(dx / n.width) > Math.abs(dy / n.height)
            ? [Math.sign(dx), 0]
            : [0, Math.sign(dy)],
        ...(e.direction ? { direction: e.direction } : {}),
        owner: proxyOwner.get(g.id)!,
      };
    }
    const port = e.port && vertex.ports.find((p) => p.name === e.port);
    const p = port ? port.position : boundary(vertex, toward),
      dx = p[0] - vertex.x - vertex.width / 2,
      dy = p[1] - vertex.y - vertex.height / 2;
    return {
      position: p,
      normal: port
        ? port.normal
        : Math.abs(dx / vertex.width) > Math.abs(dy / vertex.height)
          ? [Math.sign(dx), 0]
          : [0, Math.sign(dy)],
      ...(e.direction ? { direction: e.direction } : {}),
      owner: e.vertex,
    };
  };
  const oldEdges = new Map(
    previous?.edges.map((e) => [JSON.stringify([e.hit.index.type, e.hit.id]), e]),
  );
  const changedBoxes: Rect[] = [];
  const changedVertices = new Set<number>();
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
          port.position.some((v, axis) => v !== before.position[axis]) ||
          port.normal.some((v, axis) => v !== before.normal[axis])
        );
      })
    ) {
      changedVertices.add(i);
      changedBoxes.push(expand(rect(n), options.routeClearance));
      if (p) changedBoxes.push(expand(rect(p), options.routeClearance));
    }
  });
  const groupSame =
    previous &&
    scene.groups.length === previous.groups.length &&
    scene.groups.every(
      (g, i) =>
        g.id === previous.groups[i].id &&
        g.collapsed === previous.groups[i].collapsed &&
        g.bounds.every((v, j) => v === previous.groups[i].bounds[j]),
    );
  const affected = new Set<string>();
  if (previous && changedBoxes.length) {
    const routes = new SpatialIndex(limits.pickingBytes);
    previous.edges.forEach((e) => routes.add(expand(e.bounds, options.routeClearance)));
    for (const box of changedBoxes)
      for (const i of routes.query(box))
        affected.add(JSON.stringify([previous.edges[i].hit.index.type, previous.edges[i].hit.id]));
  }
  let routePoints = 0;
  for (const edge of scene.edges) {
    await work.step();
    edge.paths = [];
    edge.arrows = [];
    edge.junctions = [];
    const ends = edge.ends.filter((e) => scene.vertices[e.vertex].visible);
    if (ends.length * 2 + routePoints > limits.routePoints)
      throw failure('resource-limit', 'Too many route points');
    if (!edge.visible || ends.length < 2) continue;
    if (ends.every((e) => proxy.get(e.vertex) && proxy.get(e.vertex) === proxy.get(ends[0].vertex)))
      continue;
    const old = oldEdges.get(JSON.stringify([edge.hit.index.type, edge.hit.id]));
    if (
      groupSame &&
      previous?.routeClearance === options.routeClearance &&
      !edge.ends.some((e) => changedVertices.has(e.vertex)) &&
      !affected.has(JSON.stringify([edge.hit.index.type, edge.hit.id])) &&
      old &&
      old.options.route === edge.options.route &&
      old.options.arrows === edge.options.arrows &&
      old.options.appearance === edge.options.appearance &&
      JSON.stringify(old.ends) === JSON.stringify(edge.ends)
    ) {
      edge.paths = old.paths;
      edge.offsets = old.offsets;
      edge.arrows = old.arrows;
      edge.junctions = old.junctions;
      edge.anchor = old.anchor;
      edge.bounds = union(
        old.paths.flatMap((path) => path.map((p) => [p[0], p[1], p[0], p[1]] as Rect)),
      );
    } else {
      const preferred = edge.ends[rootEnd(edge)];
      const root = ends.includes(preferred) ? preferred : ends[0],
        center = (e: End): Point => {
          const n = scene.vertices[e.vertex];
          return [n.x + n.width / 2, n.y + n.height / 2];
        };
      const targets = ends.filter((e) => e !== root),
        rootPoint = routeEnd(root, center(targets[0]));
      const all = [rootPoint, ...targets.map((e) => routeEnd(e, center(root)))];
      let paths: readonly (readonly Point[])[];
      if (typeof edge.options.route === 'object')
        paths = edge.options.route.route({
          ends: all,
          obstacles: obstacles.boxes,
          clearance: options.routeClearance,
          signal,
        });
      else
        paths = targets.map((target, j) => {
          const a = rootPoint,
            b = all[j + 1],
            stub = options.routeClearance;
          const stubPoint = (end: typeof a): Point => {
            const own = ownerBounds.get(end.owner),
              axis = end.normal[0] ? 0 : 1,
              exit = own
                ? Math.max(
                    0,
                    (own[end.normal[axis] > 0 ? axis + 2 : axis] - end.position[axis]) *
                      end.normal[axis],
                  )
                : 0;
            let length = exit + stub;
            const far: Point = [
              end.position[0] + end.normal[0] * length,
              end.position[1] + end.normal[1] * length,
            ];
            const region: Rect = [
              Math.min(end.position[0], far[0]),
              Math.min(end.position[1], far[1]),
              Math.max(end.position[0], far[0]),
              Math.max(end.position[1], far[1]),
            ];
            for (const id of obstacles.query(region)) {
              if (owners[id] === end.owner) continue;
              const box = obstacles.boxes[id],
                axis = end.normal[0] ? 0 : 1;
              const distance =
                (box[end.normal[axis] > 0 ? axis : axis + 2] - end.position[axis]) *
                end.normal[axis];
              if (distance > exit) length = Math.min(length, (exit + distance) * 0.5);
            }
            return [
              end.position[0] + end.normal[0] * length,
              end.position[1] + end.normal[1] * length,
            ];
          };
          const ap = stubPoint(a),
            bp = stubPoint(b);
          if (edge.options.route === 'straight' && root.vertex !== target.vertex)
            return [a.position, b.position];
          const region = expand(
            union([
              [ap[0], ap[1], ap[0], ap[1]],
              [bp[0], bp[1], bp[0], bp[1]],
            ]),
            stub * 4,
          );
          const boxes = obstacles.query(region).map((i) => obstacles.boxes[i]);
          return simplify([
            a.position,
            ap,
            ...orthogonal(ap, bp, boxes, stub, signal),
            bp,
            b.position,
          ]);
        });
      if (paths.some((path) => path.some((p) => p.length !== 2 || !p.every(Number.isFinite))))
        throw failure('invalid-input', 'Router returned invalid points');
      const arrows: { point: Point; direction: Point }[] = [];
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i],
          end = all[Math.min(i + 1, all.length - 1)];
        if (p.length > 1 && edge.options.arrows && end.direction === 'in') {
          const a = p[p.length - 2],
            b = p[p.length - 1],
            d = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (d) arrows.push({ point: b, direction: [(b[0] - a[0]) / d, (b[1] - a[1]) / d] });
        }
      }
      if (edge.options.arrows && root.direction === 'in' && paths[0]?.length > 1) {
        const [a, b] = paths[0],
          d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (d) arrows.push({ point: a, direction: [(a[0] - b[0]) / d, (a[1] - b[1]) / d] });
      }
      if (paths.reduce((n, p) => n + p.length, 0) + routePoints > limits.routePoints)
        throw failure('resource-limit', 'Too many route points');
      const merged = segments(paths);
      edge.paths = edge.options.appearance === 'tag' ? [] : merged.paths;
      edge.offsets = edge.options.appearance === 'tag' ? all.map(() => 0) : merged.offsets;
      edge.junctions = merged.junctions;
      edge.arrows = arrows;
      edge.anchor = all[0].position;
      edge.bounds = union(paths.flatMap((p) => p.map((q) => [q[0], q[1], q[0], q[1]] as Rect)));
      if (edge.options.appearance === 'tag')
        edge.paths = all.map((p) => [
          p.position,
          [
            p.position[0] + p.normal[0] * stubLength(options),
            p.position[1] + p.normal[1] * stubLength(options),
          ],
        ]);
    }
    if (edge.options.appearance === 'tag')
      edge.bounds = union(
        edge.paths.flatMap((path) => {
          const p = path.at(-1)!;
          return [
            [path[0][0], path[0][1], path[0][0], path[0][1]],
            [p[0], p[1] - edge.label.height - 3, p[0] + edge.label.width + 6, p[1] + 3],
          ] as Rect[];
        }),
      );
    routePoints += edge.paths.reduce((n, p) => n + p.length, 0);
    if (routePoints > limits.routePoints) throw failure('resource-limit', 'Too many route points');
  }
  for (const edge of scene.edges) {
    edge.labelBounds = [];
    if (!edge.visible || !options.labels || !edge.label.runs.length) continue;
    if (edge.options.appearance === 'tag')
      edge.labelBounds = edge.paths.map((path) => {
        const p = path.at(-1)!;
        return [p[0], p[1] - edge.label.height - 3, p[0] + edge.label.width + 6, p[1] + 3];
      });
  }
  const labels = new SpatialIndex(limits.pickingBytes);
  for (let i = 0; i < scene.vertices.length; i++)
    if (scene.vertices[i].visible && !hidden.has(i)) labels.add(rect(scene.vertices[i]));
  for (const edge of scene.edges)
    if (
      edge.visible &&
      options.labels &&
      edge.paths.length &&
      edge.label.runs.length &&
      edge.options.appearance !== 'tag'
    ) {
      const candidates = edge.paths
        .flatMap((path) =>
          path.slice(1).map((b, i) => ({
            a: path[i],
            b,
            length: Math.hypot(b[0] - path[i][0], b[1] - path[i][1]),
          })),
        )
        .sort((a, b) => b.length - a.length);
      let anchor: Point = edge.anchor,
        chosen: Rect | undefined;
      for (let offset = 0; offset < 64 && !chosen; offset++)
        for (const { a, b } of candidates) {
          const x = (a[0] + b[0]) / 2 - edge.label.width / 2,
            y = (a[1] + b[1]) / 2 - 4 - edge.label.height - offset * (edge.label.height + 4);
          const box: Rect = [x, y, x + edge.label.width, y + edge.label.height];
          if (!labels.query(expand(box, 3)).length) {
            chosen = box;
            anchor = [x - 4, y + edge.label.height + 4];
            break;
          }
        }
      edge.anchor = anchor;
      const box = chosen ?? [
        anchor[0] + 4,
        anchor[1] - edge.label.height - 4,
        anchor[0] + edge.label.width + 4,
        anchor[1] - 4,
      ];
      edge.labelBounds = [expand(box, 3)];
      labels.add(box);
      edge.bounds = union([edge.bounds, ...edge.labelBounds]);
    }
  for (const i of hidden) scene.vertices[i].visible = false;
  for (const id of hiddenGroups) {
    const g = groups.get(id)!;
    g.bounds = [0, 0, 0, 0];
  }
  scene.bounds = union([
    ...scene.vertices.filter((n) => n.visible).map(rect),
    ...scene.edges.filter((e) => e.visible && e.paths.length).map((e) => e.bounds),
    ...scene.groups.filter((g) => g.bounds[0] !== g.bounds[2]).map((g) => g.bounds),
  ]);
  scene.routeClearance = options.routeClearance;
  scene.routeBytes = routePoints * 24;
  scene.bytes += scene.routeBytes;
  work.check();
  if (scene.bytes > limits.geometryBytes)
    throw failure('resource-limit', 'Route geometry exceeds budget');
}
function stubLength(options: Style): number {
  return options.routeClearance;
}
