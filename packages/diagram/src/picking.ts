import { kit, type Viewport } from '@latkit/gpu';
import { failure } from '@latkit/model';
import type { DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';
import type { Scene, Rect } from './scene.js';
import { rect, expand, union, labelBounds, edgeAnchor, itemAt, itemSlots } from './scene.js';
import { contains, distance } from './geometry.js';
import type { Values } from './values.js';
export interface HitStyle {
  readonly edgeWidthPx: number;
  readonly values: Values;
}
interface Entry {
  slot: number;
  vertex?: number;
  a?: Point;
  b?: Point;
  point?: Point;
  box: Rect;
  edgeSlot?: number;
}
interface Match {
  readonly slot: number;
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
  readonly spatial: kit.BoxIndex;
  /** Visible vertices, which the data framing needs. */
  readonly drawn: number = 0;
  /** Entries in draw order: groups, wires, wire labels, then each vertex and its ports. */
  private entries: Entry[] = [];
  private anchors = new Map<number, Point>();
  constructor(
    readonly scene: Scene,
    maxBytes: number,
  ) {
    const add = (e: Entry) => {
      this.entries.push(e);
      if (
        kit.BoxIndex.bytes(this.entries.length) +
          this.entries.length * 80 +
          (this.anchors.size + this.scene.slots.count) * 64 >
        maxBytes
      )
        throw failure('resource-limit', 'Picking exceeds budget');
    };
    scene.groups.forEach((g, i) => {
      if (g.bounds[0] === g.bounds[2]) return;
      const slot = scene.slots.groups + i;
      add({ slot, box: g.bounds });
      this.anchors.set(slot, [(g.bounds[0] + g.bounds[2]) / 2, g.bounds[1] + 12]);
    });
    const wires = scene.edges
      .map((edge, i) => ({ edge, slot: scene.slots.edges + i }))
      .filter(({ edge }) => edge.visible && edge.paths.length);
    for (const { edge, slot } of wires) {
      this.anchors.set(slot, edgeAnchor(edge));
      for (const path of edge.paths)
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1],
            b = path[i];
          add({
            slot,
            edgeSlot: slot,
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
    for (const { edge, slot } of wires)
      for (const position of edge.labels) add({ slot, box: labelBounds(edge, position) });
    let drawn = 0;
    scene.vertices.forEach((vertex, i) => {
      if (!vertex.visible) return;
      drawn++;
      add({ slot: i, vertex: i, box: rect(vertex) });
      this.anchors.set(i, [vertex.x + vertex.width / 2, vertex.y + vertex.height / 2]);
      for (const [j, port] of vertex.ports.entries()) {
        const slot = vertex.portSlot + j;
        add({ slot, point: port.position, box: [...port.position, ...port.position] });
        this.anchors.set(slot, port.position);
      }
    });
    this.drawn = drawn;
    this.spatial = kit.BoxIndex.of(
      this.entries.length,
      union(this.entries.map((entry) => entry.box)),
      (i, box) => box.set(this.entries[i].box),
    );
    if (this.bytes > maxBytes) throw failure('resource-limit', 'Picking exceeds budget');
  }
  get bytes(): number {
    return (
      this.spatial.bytes +
      this.entries.length * 80 +
      (this.anchors.size + this.scene.slots.count) * 64
    );
  }
  has(item: DiagramItem): boolean {
    return itemSlots(this.scene).has(itemKey(item));
  }
  locate(item: DiagramItem): Point | null {
    const slot = itemSlots(this.scene).get(itemKey(item));
    return slot === undefined ? null : (this.anchors.get(slot) ?? null);
  }
  /** Every item within the radius, nearest first and topmost breaking ties. */
  hit(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports = true,
    check: () => void = unchecked,
    style?: HitStyle,
  ): readonly DiagramItem[] {
    const matches = new Map<number, Match>();
    this.scan(
      point,
      camera,
      viewport,
      radius,
      ports,
      check,
      (match) => {
        const key = match.slot,
          old = matches.get(key);
        if (!old || compare(match, old) < 0) matches.set(key, match);
      },
      style,
    );
    return [...matches.values()].sort(compare).map((match) => itemAt(this.scene, match.slot)!);
  }
  /** The nearest item, without collecting the rest; `check` bounds the search. */
  nearest(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports: boolean,
    check: () => void,
    style?: HitStyle,
  ): DiagramItem | null {
    let best: Match | undefined;
    this.scan(
      point,
      camera,
      viewport,
      radius,
      ports,
      check,
      (match) => {
        if (!best || compare(match, best) < 0) best = match;
      },
      style,
    );
    return best ? itemAt(this.scene, best.slot) : null;
  }
  marquee(box: Rect): readonly DiagramItem[] {
    return [...this.spatial.query(box)]
      .map((i) => this.entries[i])
      .filter((e) => e.vertex !== undefined)
      .map((e) => itemAt(this.scene, e.slot)!);
  }
  bounds(items?: readonly DiagramItem[]): Rect[] {
    if (!items) return [this.scene.bounds];
    const slots = itemSlots(this.scene);
    const keys = new Set(items.map((item) => slots.get(itemKey(item))));
    return this.entries.filter((e) => keys.has(e.slot)).map((e) => expand(e.box, 2));
  }
  private scan(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports: boolean,
    check: () => void,
    found: (match: Match) => void,
    style?: HitStyle,
  ): void {
    const world = kit.worldPoint(camera, point, viewport),
      stroke = Math.max(style?.edgeWidthPx ?? 1.5, style?.values.maxWidth ?? 0) / 2,
      portRadius = (this.scene.portSize ?? 8) / 2,
      dx = (radius + stroke) / camera.scale[0] + portRadius,
      dy = (radius + stroke) / camera.scale[1] + portRadius;
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
          Math.hypot(point[0] - p[0], point[1] - p[1]) - portRadius * Math.max(...camera.scale),
        );
      } else if (e.a && e.b)
        d = Math.max(
          0,
          distance(
            point,
            kit.cameraPoint(camera, e.a, viewport),
            kit.cameraPoint(camera, e.b, viewport),
          ) -
            (e.edgeSlot !== undefined && style && style.values.items[e.edgeSlot].width >= 0
              ? style.values.items[e.edgeSlot].width
              : (style?.edgeWidthPx ?? 1.5)) /
              2,
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
      if (d <= radius) found({ slot: e.slot, distance: d, order: id });
    }
  }
}
