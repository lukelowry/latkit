import { GpuError } from '@latkit/gpu';
import type { ConnectProposal } from './diagram.js';
import type { DiagramHit, DiagramItem, RowRef, Point } from './data.js';
import { itemKey } from './data.js';
import type { Vertex, Port, Scene } from './scene.js';
import { rect } from './scene.js';
import { boundary, orthogonal } from './geometry.js';
import { rootEnd } from './layout.js';
import { SpatialIndex, expand } from './spatial.js';

export type ConnectStart = Pick<ConnectProposal, 'from' | 'replaces'>;
const identity = (ref: RowRef) => JSON.stringify([ref.type, ref.id]);

/** One immutable topology lookup per gesture; pointer moves only query nearby candidates. */
export class ConnectSession {
  readonly start: ConnectStart;
  readonly compatible: readonly DiagramItem[];
  private vertices = new Map<string, Vertex>();
  private edges = new Map<string, Scene['edges'][number]>();
  private obstacles = new SpatialIndex();
  private owners: Vertex[] = [];
  private source: Vertex;
  private port?: Port;
  constructor(
    private readonly scene: Scene,
    hit: Exclude<DiagramHit, { kind: 'group' }>,
    private readonly clearance: number,
  ) {
    for (const vertex of scene.vertices) {
      this.vertices.set(identity(vertex.hit), vertex);
      if (vertex.visible) {
        this.obstacles.add(expand(rect(vertex), 2));
        this.owners.push(vertex);
      }
    }
    for (const edge of scene.edges) this.edges.set(identity(edge.hit), edge);
    let source = this.vertices.get(identity(hit))!;
    let port = hit.kind === 'port' ? source.ports.find((p) => p.name === hit.port) : undefined;
    this.start = { from: { type: hit.type, id: hit.id, ...(port ? { port: port.name } : {}) } };
    // Dragging a wired input moves it: the new wiring starts from its net's source.
    if (port?.direction === 'in') {
      const vertexIndex = scene.vertices.indexOf(source),
        moved = { type: hit.type, id: hit.id, port: port.name };
      for (const edge of scene.edges) {
        const end = edge.ends.find((e) => e.vertex === vertexIndex && e.port === moved.port);
        const root = edge.ends[rootEnd(edge)];
        if (!end || !root || root === end) continue;
        source = scene.vertices[root.vertex];
        port = source.ports.find((p) => p.name === root.port);
        this.start = {
          from: {
            type: source.hit.type,
            id: source.hit.id,
            ...(root.port ? { port: root.port } : {}),
          },
          replaces: { edge: { type: edge.hit.type, id: edge.hit.id }, end: moved },
        };
        break;
      }
    }
    this.source = source;
    this.port = port;
    const compatible: DiagramItem[] = [];
    for (const vertex of scene.vertices)
      if (vertex.visible)
        for (const candidate of vertex.ports) {
          const item = { ...vertex.hit, kind: 'port' as const, port: candidate.name };
          if (this.accepts(item)) compatible.push(item);
        }
    for (const edge of scene.edges)
      if (edge.visible && this.accepts(edge.hit)) compatible.push(edge.hit);
    this.compatible = compatible;
  }
  accepts(item: DiagramItem): boolean {
    if (item.kind === 'group') return false;
    if (item.kind === 'edge') {
      // Moving an end between nets requires an explicit application merge command.
      if (this.start.replaces) return false;
      // A port joins a net of the type it references, once.
      const edge = this.edges.get(identity(item));
      return (
        !!edge &&
        !!this.port &&
        edge.hit.type === this.port.to &&
        !edge.ends.some(
          (end) => this.scene.vertices[end.vertex] === this.source && end.port === this.port!.name,
        )
      );
    }
    const vertex = this.vertices.get(identity(item));
    if (!vertex || !vertex.visible) return false;
    const port = item.kind === 'port' ? vertex.ports.find((p) => p.name === item.port) : undefined;
    if (vertex === this.source && port === this.port) return false;
    if (item.kind === 'port' && !port) return false;
    // Two ports wire together through a net they both reference, and never input to input.
    const a = this.port,
      b = port;
    if (a && b && (a.to !== b.to || (a.direction && a.direction === b.direction))) return false;
    if (this.start.replaces) {
      const edge = this.edges.get(identity(this.start.replaces.edge))!;
      if (
        edge.ends.some(
          (end) => this.scene.vertices[end.vertex] === vertex && end.port === (port?.name ?? null),
        )
      )
        return false;
    }
    return true;
  }
  proposal(item: DiagramItem | null, position: Point, point: Point): ConnectProposal {
    return {
      ...this.start,
      position,
      point,
      to:
        item && item.kind !== 'group'
          ? {
              kind: item.kind === 'edge' ? 'edge' : 'vertex',
              type: item.type,
              id: item.id,
              ...(item.kind === 'port' ? { port: item.port } : {}),
            }
          : null,
    };
  }
  preview(point: Point, target: DiagramItem | null, signal: AbortSignal): readonly Point[] {
    const vertex =
      target && target.kind !== 'edge' && target.kind !== 'group'
        ? this.vertices.get(identity(target))
        : undefined;
    const port =
      target?.kind === 'port' ? vertex?.ports.find((p) => p.name === target.port) : undefined;
    const a = this.port?.position ?? boundary(this.source, point);
    const b = port?.position ?? (vertex ? boundary(vertex, a) : point);
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
      .filter((i) => this.owners[i] !== this.source && this.owners[i] !== vertex)
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
    return this.start.replaces ? itemKey({ kind: 'edge', ...this.start.replaces.edge }) : undefined;
  }
}
