import { GpuError } from '@latkit/gpu';
import type { ConnectionGesture } from './diagram.js';
import type { DiagramHit, DiagramItem, EntityRef, Point } from './data.js';
import { itemKey } from './data.js';
import type { Node, Port, Scene } from './scene.js';
import { rect } from './scene.js';
import { boundary, orthogonal } from './geometry.js';
import { rootEndpoint } from './layout.js';
import { SpatialIndex, expand } from './spatial.js';

export type ConnectionStart = Pick<ConnectionGesture, 'from' | 'replaces'>;
const identity = (ref: EntityRef) => JSON.stringify([ref.type, ref.id]);

/** One immutable topology lookup per gesture; pointer moves only query nearby candidates. */
export class ConnectionSession {
  readonly start: ConnectionStart;
  readonly compatible: readonly DiagramItem[];
  private nodes = new Map<string, Node>();
  private edges = new Map<string, Scene['edges'][number]>();
  private obstacles = new SpatialIndex();
  private owners: Node[] = [];
  private source: Node;
  private port?: Port;
  constructor(
    private readonly scene: Scene,
    hit: Exclude<DiagramHit, { kind: 'group' }>,
    private readonly clearance: number,
  ) {
    for (const node of scene.nodes) {
      this.nodes.set(identity(node.hit), node);
      if (node.visible) {
        this.obstacles.add(expand(rect(node), 2));
        this.owners.push(node);
      }
    }
    for (const edge of scene.edges) this.edges.set(identity(edge.hit), edge);
    let source = this.nodes.get(identity(hit))!;
    let port = hit.kind === 'port' ? source.ports.find((p) => p.name === hit.port) : undefined;
    this.start = { from: { type: hit.type, id: hit.id, ...(port ? { port: port.name } : {}) } };
    if (port?.definition.direction === 'in') {
      const nodeIndex = scene.nodes.indexOf(source);
      for (const edge of scene.edges) {
        const end = edge.endpoints.find((e) => e.node === nodeIndex && e.port === port!.name);
        const root = edge.endpoints[rootEndpoint(scene, edge)];
        if (!end || !root || root === end) continue;
        source = scene.nodes[root.node];
        port = source.ports.find((p) => p.name === root.port);
        this.start = {
          from: {
            type: source.hit.type,
            id: source.hit.id,
            ...(root.port ? { port: root.port } : {}),
          },
          replaces: {
            connection: { type: edge.hit.type, id: edge.hit.id },
            endpoint: { ordinal: end.ordinal, index: edge.hit.index, role: end.role },
          },
        };
        break;
      }
    }
    this.source = source;
    this.port = port;
    const compatible: DiagramItem[] = [];
    for (const node of scene.nodes)
      if (node.visible)
        for (const candidate of node.ports) {
          const item = { ...node.hit, kind: 'port' as const, port: candidate.name };
          if (this.accepts(item)) compatible.push(item);
        }
    for (const edge of scene.edges)
      if (edge.visible && this.accepts(edge.hit)) compatible.push(edge.hit);
    this.compatible = compatible;
  }
  accepts(item: DiagramItem): boolean {
    if (item.kind === 'group') return false;
    if (item.kind === 'connection') {
      // Moving an endpoint between connections requires an explicit application merge command.
      if (this.start.replaces) return false;
      const edge = this.edges.get(identity(item));
      return (
        !!edge &&
        !edge.endpoints.some((end) => {
          const node = this.scene.nodes[end.node];
          if (node === this.source && end.port === (this.port?.name ?? null)) return true;
          const port = node.ports.find((p) => p.name === end.port);
          return !!(
            this.port?.definition.type &&
            port?.definition.type &&
            this.port.definition.type !== port.definition.type
          );
        })
      );
    }
    const node = this.nodes.get(identity(item));
    if (!node || !node.visible) return false;
    const port = item.kind === 'port' ? node.ports.find((p) => p.name === item.port) : undefined;
    if (node === this.source && port === this.port) return false;
    if (item.kind === 'port' && !port) return false;
    const a = this.port?.definition,
      b = port?.definition;
    if (
      a &&
      b &&
      ((a.type && b.type && a.type !== b.type) ||
        (a.direction === b.direction && a.direction !== 'both'))
    )
      return false;
    if (this.start.replaces) {
      const edge = this.edges.get(identity(this.start.replaces.connection))!;
      if (
        edge.endpoints.some(
          (end) => this.scene.nodes[end.node] === node && end.port === (port?.name ?? null),
        )
      )
        return false;
    }
    return true;
  }
  proposal(item: DiagramItem | null, position: Point, point: Point): ConnectionGesture {
    return {
      ...this.start,
      position,
      point,
      to:
        item && item.kind !== 'group'
          ? {
              kind: item.kind === 'connection' ? 'connection' : 'component',
              type: item.type,
              id: item.id,
              ...(item.kind === 'port' ? { port: item.port } : {}),
            }
          : null,
    };
  }
  preview(point: Point, target: DiagramItem | null, signal: AbortSignal): readonly Point[] {
    const node =
      target && target.kind !== 'connection' && target.kind !== 'group'
        ? this.nodes.get(identity(target))
        : undefined;
    const port =
      target?.kind === 'port' ? node?.ports.find((p) => p.name === target.port) : undefined;
    const a = this.port?.position ?? boundary(this.source, point);
    const b = port?.position ?? (node ? boundary(node, a) : point);
    const normal = this.port?.normal ?? [Math.sign(b[0] - a[0]) || 1, 0];
    const ap: Point = [a[0] + normal[0] * this.clearance, a[1] + normal[1] * this.clearance];
    const bp: Point = port
      ? [b[0] + port.normal[0] * this.clearance, b[1] + port.normal[1] * this.clearance]
      : b;
    const region = expand(
      [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
      this.clearance * 4,
    );
    const boxes = this.obstacles
      .query(region)
      .filter((i) => this.owners[i] !== this.source && this.owners[i] !== node)
      .map((i) => this.obstacles.boxes[i]);
    try {
      return [a, ap, ...orthogonal(ap, bp, boxes, this.clearance, signal), bp, b];
    } catch (error) {
      signal.throwIfAborted();
      // Overlapping blocks can temporarily enclose the pointer. Keep the gesture cancellable.
      if (!(error instanceof GpuError) || !['invalid-input', 'resource-limit'].includes(error.code))
        throw error;
      return [a, ap, [bp[0], ap[1]], bp, b];
    }
  }
  get detached(): string | undefined {
    return this.start.replaces
      ? itemKey({ kind: 'connection', ...this.start.replaces.connection })
      : undefined;
  }
}
