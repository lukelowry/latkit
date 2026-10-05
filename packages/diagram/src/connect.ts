import type { ConnectProposal } from './diagram.js';
import type { DiagramItem, DiagramPort, DiagramRow, Point, SceneItem } from './data.js';
import { itemKey, rowOf } from './data.js';
import type { Port, Scene } from './scene.js';
import type { Style } from './config.js';
import { Routing } from './route.js';
import { rootEnd } from './layout.js';

export type ConnectStart = Pick<ConnectProposal, 'from' | 'replaces'>;
/** A vertex or edge row, whichever kind names it. */
const identity = (item: Exclude<DiagramItem, { kind: 'group' }>) =>
  itemKey({ ...item, kind: 'vertex' });

/** One immutable topology lookup per gesture; pointer moves only query nearby candidates. */
export class ConnectSession {
  readonly start: ConnectStart;
  readonly compatible: readonly DiagramItem[];
  private vertices = new Map<string, number>();
  private edges = new Map<string, Scene['edges'][number]>();
  private source: number;
  private port?: Port;
  constructor(
    private readonly scene: Scene,
    hit: Exclude<DiagramItem, { kind: 'group' }>,
    private readonly options: Style,
  ) {
    scene.vertices.forEach((vertex, i) => this.vertices.set(identity(vertex.hit), i));
    for (const edge of scene.edges) this.edges.set(identity(edge.hit), edge);
    let source = this.vertices.get(identity(hit))!;
    let port =
      hit.kind === 'port'
        ? scene.vertices[source].ports.find((p) => p.name === hit.port)
        : undefined;
    this.start = { from: endOf(scene.vertices[source].hit, port?.name) };
    // Dragging a wired input moves it: the new wiring starts from its net's source.
    if (port?.direction === 'in') {
      const moved = endOf(scene.vertices[source].hit, port.name) as DiagramPort;
      for (const edge of scene.edges) {
        const end = edge.ends.find((e) => e.vertex === source && e.port === moved.port);
        const root = edge.ends[rootEnd(edge)];
        if (!end || !root || root === end) continue;
        source = root.vertex;
        port = scene.vertices[source].ports.find((p) => p.name === root.port);
        this.start = {
          from: endOf(scene.vertices[source].hit, root.port ?? undefined),
          replaces: { edge: rowOf(edge.hit), end: moved },
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
        edge.hit.index.type === this.port.to &&
        !edge.ends.some((end) => end.vertex === this.source && end.port === this.port!.name)
      );
    }
    const index = this.vertices.get(identity(item)),
      vertex = index === undefined ? undefined : this.scene.vertices[index];
    if (!vertex || !vertex.visible) return false;
    const port = item.kind === 'port' ? vertex.ports.find((p) => p.name === item.port) : undefined;
    if (index === this.source && port === this.port) return false;
    if (item.kind === 'port' && !port) return false;
    // Two ports wire together through a net they both reference, and never input to input.
    const a = this.port,
      b = port;
    if (a && b && (a.to !== b.to || (a.direction && a.direction === b.direction))) return false;
    if (this.start.replaces) {
      const edge = this.edges.get(identity(this.start.replaces.edge))!;
      if (edge.ends.some((end) => end.vertex === index && end.port === (port?.name ?? null)))
        return false;
    }
    return true;
  }
  proposal(item: DiagramItem | null, position: Point, point: Point): ConnectProposal {
    return {
      ...this.start,
      position,
      point,
      to: item && item.kind !== 'group' ? item : null,
    };
  }
  /** The wire as it would route: out of its start, around the blocks, into the target. */
  preview(point: Point, target: DiagramItem | null, signal: AbortSignal): readonly Point[] {
    const route = new Routing(this.scene, this.options, signal),
      clearance = this.options.routeClearance,
      index =
        target && target.kind !== 'edge' && target.kind !== 'group'
          ? this.vertices.get(identity(target))
          : undefined,
      port = target?.kind === 'port' ? target.port : null;
    const a = route.end({ vertex: this.source, port: this.port?.name ?? null }, point, false);
    const b =
      index === undefined ? undefined : route.end({ vertex: index, port }, a.position, false);
    const ap: Point = [
      a.position[0] + a.normal[0] * clearance,
      a.position[1] + a.normal[1] * clearance,
    ];
    if (!b) return [a.position, ap, ...route.between(ap, point).slice(1)];
    const bp: Point = [
      b.position[0] + b.normal[0] * clearance,
      b.position[1] + b.normal[1] * clearance,
    ];
    return [a.position, ...route.between(ap, bp), b.position];
  }
  get detached(): string | undefined {
    return this.start.replaces ? itemKey(this.start.replaces.edge) : undefined;
  }
}
/** Where wiring starts or ends: a vertex, or one of its ports. */
function endOf(vertex: SceneItem, port: string | undefined): DiagramRow | DiagramPort {
  return port === undefined
    ? { kind: 'vertex', source: vertex.source, index: vertex.index, row: vertex.row }
    : { kind: 'port', source: vertex.source, index: vertex.index, row: vertex.row, port };
}
