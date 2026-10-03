import { kit, type Viewport } from '@latkit/gpu';
import type { DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';
import type { Scene, Rect } from './scene.js';
import { rect } from './scene.js';
import { contains, distance } from './geometry.js';
import { SpatialIndex, expand } from './spatial.js';
interface Entry {
  hit: DiagramItem;
  vertex?: number;
  a?: Point;
  b?: Point;
  point?: Point;
  box: Rect;
  radius?: number;
}
interface Match {
  readonly hit: DiagramItem;
  readonly distance: number;
  /** Draw order: a later entry draws over an earlier one. */
  readonly order: number;
}
const unchecked = () => {};
/** Nearest first; what draws later is on top, so it wins ties. */
function compare(a: Match, b: Match): number {
  return a.distance - b.distance || b.order - a.order;
}
export class Picking {
  readonly spatial: SpatialIndex;
  /** Visible vertices, which the data framing needs. */
  readonly drawn: number = 0;
  /** Entries in draw order: groups, wires, wire labels, then each vertex and its ports. */
  private entries: Entry[] = [];
  private maxStroke = 0;
  private anchors = new Map<string, Point>();
  private identities = new Set<string>();
  constructor(
    readonly scene: Scene,
    maxBytes: number,
  ) {
    this.spatial = new SpatialIndex(maxBytes);
    this.maxStroke = (scene.portSizePx ?? 8) / 2;
    for (const group of scene.groups) this.identities.add(itemKey({ kind: 'group', id: group.id }));
    for (const edge of scene.edges) this.identities.add(itemKey(edge.hit));
    for (const vertex of scene.vertices) {
      this.identities.add(itemKey(vertex.hit));
      for (const port of vertex.ports)
        this.identities.add(itemKey({ ...vertex.hit, kind: 'port', port: port.name }));
    }
    const add = (e: Entry) => {
      this.spatial.add(e.box);
      this.entries.push(e);
    };
    scene.groups.forEach((g) => {
      if (g.bounds[0] === g.bounds[2]) return;
      const hit: DiagramItem = { kind: 'group', id: g.id };
      add({ hit, box: g.bounds });
      this.anchors.set(itemKey(hit), [(g.bounds[0] + g.bounds[2]) / 2, g.bounds[1] + 12]);
    });
    const wires = scene.edges.filter((edge) => edge.visible && edge.paths.length);
    for (const edge of wires) {
      this.maxStroke = Math.max(this.maxStroke, edge.width / 2);
      this.anchors.set(itemKey(edge.hit), edge.anchor);
      for (const path of edge.paths)
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1],
            b = path[i];
          add({
            hit: edge.hit,
            radius: edge.width / 2,
            a,
            b,
            box: [
              Math.min(a[0], b[0]),
              Math.min(a[1], b[1]),
              Math.max(a[0], b[0]),
              Math.max(a[1], b[1]),
            ],
          });
        }
    }
    for (const edge of wires) for (const box of edge.labelBounds) add({ hit: edge.hit, box });
    let drawn = 0;
    scene.vertices.forEach((vertex, i) => {
      if (!vertex.visible) return;
      drawn++;
      add({ hit: vertex.hit, vertex: i, box: rect(vertex) });
      this.anchors.set(itemKey(vertex.hit), [
        vertex.x + vertex.width / 2,
        vertex.y + vertex.height / 2,
      ]);
      for (const port of vertex.ports) {
        const hit: DiagramItem = { ...vertex.hit, kind: 'port', port: port.name };
        add({ hit, point: port.position, box: [...port.position, ...port.position] });
        this.anchors.set(itemKey(hit), port.position);
      }
    });
    this.drawn = drawn;
  }
  get bytes(): number {
    return (
      this.spatial.bytes +
      this.entries.length * 80 +
      (this.anchors.size + this.identities.size) * 64
    );
  }
  has(item: DiagramItem): boolean {
    return this.identities.has(itemKey(item));
  }
  locate(item: DiagramItem): Point | null {
    return this.anchors.get(itemKey(item)) ?? null;
  }
  /** Every item within the radius, nearest first and topmost breaking ties. */
  hit(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports = true,
    check: () => void = unchecked,
  ): readonly DiagramItem[] {
    const matches = new Map<string, Match>();
    this.scan(point, camera, viewport, radius, ports, check, (match) => {
      const key = itemKey(match.hit),
        old = matches.get(key);
      if (!old || compare(match, old) < 0) matches.set(key, match);
    });
    return [...matches.values()].sort(compare).map((match) => match.hit);
  }
  /** The nearest item, without collecting the rest; `check` bounds the search. */
  nearest(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports: boolean,
    check: () => void,
  ): DiagramItem | null {
    let best: Match | undefined;
    this.scan(point, camera, viewport, radius, ports, check, (match) => {
      if (!best || compare(match, best) < 0) best = match;
    });
    return best?.hit ?? null;
  }
  marquee(box: Rect): readonly DiagramItem[] {
    return this.spatial
      .query(box)
      .map((i) => this.entries[i])
      .filter((e) => e.vertex !== undefined)
      .map((e) => e.hit);
  }
  bounds(items?: readonly DiagramItem[]): Rect[] {
    if (!items) return [this.scene.bounds];
    const keys = new Set(items.map(itemKey));
    return this.entries.filter((e) => keys.has(itemKey(e.hit))).map((e) => expand(e.box, 2));
  }
  private scan(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports: boolean,
    check: () => void,
    found: (match: Match) => void,
  ): void {
    const world = kit.worldPoint(camera, point, viewport),
      dx = (radius + this.maxStroke) / camera.scale[0] + 3.5,
      dy = (radius + this.maxStroke) / camera.scale[1] + 3.5;
    for (const id of this.spatial.query(
      [world[0] - dx, world[1] - dy, world[0] + dx, world[1] + dy],
      check,
    )) {
      check();
      const e = this.entries[id];
      let d = Infinity;
      if (e.point) {
        if (!ports) continue;
        const p = kit.cameraPoint(camera, e.point, viewport);
        d = Math.max(
          0,
          Math.hypot(point[0] - p[0], point[1] - p[1]) - (this.scene.portSizePx ?? 8) / 2,
        );
      } else if (e.a && e.b)
        d = Math.max(
          0,
          distance(
            point,
            kit.cameraPoint(camera, e.a, viewport),
            kit.cameraPoint(camera, e.b, viewport),
          ) - (e.radius ?? 0),
        );
      else if (e.vertex !== undefined) {
        if (contains(this.scene.vertices[e.vertex], world)) d = 0;
      } else if (
        world[0] >= e.box[0] &&
        world[0] <= e.box[2] &&
        world[1] >= e.box[1] &&
        world[1] <= e.box[3]
      )
        d = 0;
      if (d <= radius) found({ hit: e.hit, distance: d, order: id });
    }
  }
}
