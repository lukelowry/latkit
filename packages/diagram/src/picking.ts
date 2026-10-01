import { cameraPoint, worldPoint, withinBudget } from '@latkit/gpu';
import type { Camera2D, Viewport } from '@latkit/gpu';
import type { DiagramHit, DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';
import type { Scene, Rect } from './scene.js';
import { rect } from './scene.js';
import { contains, distance } from './geometry.js';
import { SpatialIndex, expand } from './spatial.js';
interface Entry {
  hit: DiagramHit;
  kind: number;
  node?: number;
  a?: Point;
  b?: Point;
  point?: Point;
  box: Rect;
  radius?: number;
}
export class Picking {
  readonly spatial: SpatialIndex;
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
    for (const node of scene.nodes) {
      this.identities.add(itemKey(node.hit));
      for (const port of node.ports)
        this.identities.add(itemKey({ ...node.hit, kind: 'port', port: port.name }));
    }
    const add = (e: Entry) => {
      this.spatial.add(e.box);
      this.entries.push(e);
    };
    scene.groups.forEach((g) => {
      if (g.bounds[0] === g.bounds[2]) return;
      const hit: DiagramHit = { kind: 'group', id: g.id };
      add({ hit, kind: 3, box: g.bounds });
      this.anchors.set(itemKey(hit), [(g.bounds[0] + g.bounds[2]) / 2, g.bounds[1] + 12]);
    });
    scene.edges.forEach((edge) => {
      if (!edge.visible || !edge.paths.length) return;
      this.maxStroke = Math.max(this.maxStroke, edge.width / 2);
      this.anchors.set(itemKey(edge.hit), edge.anchor);
      for (const box of edge.labelBounds) add({ hit: edge.hit, kind: 2, box });
      for (const path of edge.paths)
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1],
            b = path[i];
          add({
            hit: edge.hit,
            kind: 2,
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
    });
    scene.nodes.forEach((node, i) => {
      if (!node.visible) return;
      add({ hit: node.hit, kind: 1, node: i, box: rect(node) });
      this.anchors.set(itemKey(node.hit), [node.x + node.width / 2, node.y + node.height / 2]);
      for (const port of node.ports) {
        const hit: DiagramHit = { ...node.hit, kind: 'port', port: port.name };
        add({ hit, kind: 0, point: port.position, box: [...port.position, ...port.position] });
        this.anchors.set(itemKey(hit), port.position);
      }
    });
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
  hit(
    point: Point,
    camera: Camera2D,
    viewport: Viewport,
    radius: number,
    budget?: number,
    ports = true,
  ): { items: readonly DiagramHit[]; complete: boolean } {
    const work = withinBudget((check) => {
      const world = worldPoint(camera, point, viewport),
        dx = (radius + this.maxStroke) / camera.scale[0] + 3.5,
        dy = (radius + this.maxStroke) / camera.scale[1] + 3.5;
      const matches = new Map<string, { entry: Entry; distance: number }>();
      for (const id of this.spatial.query([
        world[0] - dx,
        world[1] - dy,
        world[0] + dx,
        world[1] + dy,
      ])) {
        check();
        const e = this.entries[id];
        let d = Infinity;
        if (e.point) {
          if (!ports) continue;
          const p = cameraPoint(camera, e.point, viewport);
          d = Math.max(
            0,
            Math.hypot(point[0] - p[0], point[1] - p[1]) - (this.scene.portSizePx ?? 8) / 2,
          );
        } else if (e.a && e.b)
          d = Math.max(
            0,
            distance(
              point,
              cameraPoint(camera, e.a, viewport),
              cameraPoint(camera, e.b, viewport),
            ) - (e.radius ?? 0),
          );
        else if (e.node !== undefined) {
          if (contains(this.scene.nodes[e.node], world)) d = 0;
        } else if (
          world[0] >= e.box[0] &&
          world[0] <= e.box[2] &&
          world[1] >= e.box[1] &&
          world[1] <= e.box[3]
        )
          d = 0;
        if (d <= radius) {
          const key = itemKey(e.hit),
            old = matches.get(key);
          if (!old || d < old.distance) matches.set(key, { entry: e, distance: d });
        }
      }
      return [...matches.values()]
        .sort(
          (a, b) =>
            a.entry.kind - b.entry.kind ||
            a.distance - b.distance ||
            itemKey(a.entry.hit).localeCompare(itemKey(b.entry.hit)),
        )
        .map((v) => v.entry.hit);
    }, budget);
    return work.complete ? { items: work.value, complete: true } : { items: [], complete: false };
  }
  marquee(box: Rect): readonly DiagramItem[] {
    return this.spatial
      .query(box)
      .map((i) => this.entries[i])
      .filter((e) => e.node !== undefined)
      .map((e) => e.hit);
  }
  bounds(items?: readonly DiagramItem[]): Rect[] {
    if (!items) return [this.scene.bounds];
    const keys = new Set(items.map(itemKey));
    return this.entries.filter((e) => keys.has(itemKey(e.hit))).map((e) => expand(e.box, 2));
  }
}
