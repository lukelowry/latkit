import { kit, type Viewport } from '@latkit/gpu';
import { failure } from '@latkit/model';
import type { DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';
import type { Scene, Rect } from './scene.js';
import { expand, union, edgeAnchor, itemAt, itemSlots } from './scene.js';
import { contains, distance, labelBox } from './geometry.js';

/** What a pickable piece is, in draw order: a later piece draws over an earlier one. */
const GROUP = 0,
  SEGMENT = 1,
  LABEL = 2,
  VERTEX = 3,
  PORT = 4;
interface Match {
  readonly slot: number;
  readonly distance: number;
  readonly order: number;
}
const unchecked = () => {};
/** Nearest first; what draws later is on top, so it wins ties. */
function compare(a: Match, b: Match): number {
  return a.distance - b.distance || b.order - a.order;
}
/**
 * Every pickable piece of a scene in typed storage, draw order kept: a box, a segment, or a port's
 * point in four numbers, its kind, and its slot. About 60 bytes a piece with its index.
 */
export class Picking {
  readonly spatial: kit.BoxIndex;
  /** Visible vertices, which the data framing needs. */
  readonly drawn: number;
  private readonly kinds: Uint8Array;
  private readonly slots: Uint32Array;
  private readonly shapes: Float64Array;
  /** Each slot's anchor: where locate and reveal find it; NaN for one not drawn. */
  private readonly anchors: Float64Array;
  constructor(
    readonly scene: Scene,
    maxBytes: number,
  ) {
    const wired = (edge: Scene['edges'][number]) => edge.visible && edge.paths.length > 0;
    let count = 0;
    for (const g of scene.groups) if (g.bounds[0] !== g.bounds[2]) count++;
    for (const edge of scene.edges)
      if (wired(edge)) {
        for (const path of edge.paths) count += path.length - 1;
        count += edge.labels.length;
      }
    for (const vertex of scene.vertices) if (vertex.visible) count += 1 + vertex.ports.length;
    if (Picking.bytes(count, scene.slots.count) > maxBytes)
      throw failure('resource-limit', 'Picking exceeds budget');
    const kinds = (this.kinds = new Uint8Array(count)),
      slots = (this.slots = new Uint32Array(count)),
      s = (this.shapes = new Float64Array(count * 4)),
      anchors = (this.anchors = new Float64Array(scene.slots.count * 2).fill(NaN));
    let n = 0;
    const add = (kind: number, slot: number, a: number, b: number, c: number, d: number) => {
      kinds[n] = kind;
      slots[n] = slot;
      const at = n++ * 4;
      s[at] = a;
      s[at + 1] = b;
      s[at + 2] = c;
      s[at + 3] = d;
    };
    const anchor = (slot: number, x: number, y: number) => {
      anchors[slot * 2] = x;
      anchors[slot * 2 + 1] = y;
    };
    scene.groups.forEach(({ bounds: [x0, y0, x1, y1], header }, i) => {
      if (x0 === x1) return;
      add(GROUP, scene.slots.groups + i, x0, y0, x1, y1);
      anchor(scene.slots.groups + i, (x0 + x1) / 2, y0 + header / 2);
    });
    scene.edges.forEach((edge, i) => {
      if (!wired(edge)) return;
      const slot = scene.slots.edges + i,
        [x, y] = edgeAnchor(edge);
      anchor(slot, x, y);
      for (const path of edge.paths)
        for (let k = 1; k < path.length; k++)
          add(SEGMENT, slot, path[k - 1][0], path[k - 1][1], path[k][0], path[k][1]);
    });
    scene.edges.forEach((edge, i) => {
      if (wired(edge))
        for (const at of edge.labels) add(LABEL, scene.slots.edges + i, ...labelBox(edge, at));
    });
    let drawn = 0;
    scene.vertices.forEach((vertex, i) => {
      if (!vertex.visible) return;
      drawn++;
      add(VERTEX, i, vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height);
      anchor(i, vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
      vertex.ports.forEach(({ position: [x, y] }, k) => {
        add(PORT, vertex.portSlot + k, x, y, x, y);
        anchor(vertex.portSlot + k, x, y);
      });
    });
    this.drawn = drawn;
    const box = (i: number, out: Float64Array) => {
      out[0] = Math.min(s[i * 4], s[i * 4 + 2]);
      out[1] = Math.min(s[i * 4 + 1], s[i * 4 + 3]);
      out[2] = Math.max(s[i * 4], s[i * 4 + 2]);
      out[3] = Math.max(s[i * 4 + 1], s[i * 4 + 3]);
    };
    this.spatial = kit.BoxIndex.of(count, expand(scene.bounds, 1), box);
  }
  static bytes(pieces: number, slots: number): number {
    return pieces * 37 + kit.BoxIndex.bytes(pieces) + slots * 16;
  }
  get bytes(): number {
    return Picking.bytes(this.kinds.length, this.scene.slots.count);
  }
  has(item: DiagramItem): boolean {
    return itemSlots(this.scene).has(itemKey(item));
  }
  locate(item: DiagramItem): Point | null {
    const slot = itemSlots(this.scene).get(itemKey(item));
    return slot === undefined || Number.isNaN(this.anchors[slot * 2])
      ? null
      : [this.anchors[slot * 2], this.anchors[slot * 2 + 1]];
  }
  /** Every item within the radius, nearest first and topmost breaking ties. */
  hit(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports = true,
    check: () => void = unchecked,
    widthPx = 1.5,
  ): readonly DiagramItem[] {
    const matches = new Map<number, Match>();
    this.scan(point, camera, viewport, radius, ports, check, widthPx, (match) => {
      const old = matches.get(match.slot);
      if (!old || compare(match, old) < 0) matches.set(match.slot, match);
    });
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
    widthPx: number,
  ): DiagramItem | null {
    let best: Match | undefined;
    this.scan(point, camera, viewport, radius, ports, check, widthPx, (match) => {
      if (!best || compare(match, best) < 0) best = match;
    });
    return best ? itemAt(this.scene, best.slot) : null;
  }
  marquee(box: Rect): readonly DiagramItem[] {
    const out: DiagramItem[] = [];
    for (const i of this.spatial.query(box))
      if (this.kinds[i] === VERTEX) out.push(this.scene.vertices[this.slots[i]].hit);
    return out;
  }
  bounds(items?: readonly DiagramItem[]): Rect[] {
    if (!items) return [this.scene.bounds];
    const slots = itemSlots(this.scene),
      wanted = new Set(items.map((item) => slots.get(itemKey(item)))),
      out: Rect[] = [],
      s = this.shapes;
    for (let i = 0; i < this.kinds.length; i++)
      if (wanted.has(this.slots[i]))
        out.push(
          expand(
            union([
              [s[i * 4], s[i * 4 + 1], s[i * 4], s[i * 4 + 1]],
              [s[i * 4 + 2], s[i * 4 + 3], s[i * 4 + 2], s[i * 4 + 3]],
            ]),
            2,
          ),
        );
    return out;
  }
  private scan(
    point: Point,
    camera: kit.Camera2D,
    viewport: Viewport,
    radius: number,
    ports: boolean,
    check: () => void,
    widthPx: number,
    found: (match: Match) => void,
  ): void {
    const world = kit.worldPoint(camera, point, viewport),
      portRadius = (this.scene.portSize ?? 8) / 2,
      dx = (radius + widthPx / 2) / camera.scale[0] + portRadius,
      dy = (radius + widthPx / 2) / camera.scale[1] + portRadius,
      s = this.shapes;
    for (const i of this.spatial.query(
      [world[0] - dx, world[1] - dy, world[0] + dx, world[1] + dy],
      check,
    )) {
      check();
      const kind = this.kinds[i],
        at = i * 4;
      let d = Infinity;
      if (kind === PORT) {
        if (!ports) continue;
        const p = kit.cameraPoint(camera, [s[at], s[at + 1]], viewport);
        d = Math.max(
          0,
          Math.hypot(point[0] - p[0], point[1] - p[1]) - portRadius * camera.scale[0],
        );
      } else if (kind === SEGMENT)
        d = Math.max(
          0,
          distance(
            point,
            kit.cameraPoint(camera, [s[at], s[at + 1]], viewport),
            kit.cameraPoint(camera, [s[at + 2], s[at + 3]], viewport),
          ) -
            widthPx / 2,
        );
      else if (kind === VERTEX) {
        if (contains(this.scene.vertices[this.slots[i]], world)) d = 0;
      } else if (
        world[0] >= s[at] &&
        world[0] <= s[at + 2] &&
        world[1] >= s[at + 1] &&
        world[1] <= s[at + 3]
      )
        d = 0;
      if (d <= radius) found({ slot: this.slots[i], distance: d, order: i });
    }
  }
}
