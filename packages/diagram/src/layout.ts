import { Work, type RequestOptions } from '@latkit/model';
import { kit, type Gpu, type LayoutItem, type LayoutOptions, type Positions } from '@latkit/gpu';
import { diagramData, rowOf } from './data.js';
import type { DiagramConfig } from './diagram.js';
import {
  data as checkedData,
  resolveLimits,
  resolveStyle,
  VIEW_DEFAULTS,
  type Style,
} from './config.js';
import { readScene } from './read.js';
import {
  positions,
  groupFrame,
  sceneGraph,
  sceneKey,
  sceneRows,
  union,
  type Part,
  type Scene,
  type Vertex,
} from './scene.js';
import { labelRoom, portPositions } from './geometry.js';

/** Layout options over the diagram's defaults: ranks along the flow, with room for blocks. */
export function layoutOptions(layout?: LayoutOptions): Required<LayoutOptions> {
  return kit.layoutOptions(layout, { algorithm: 'layered', vertexGap: 24, rankGap: 64 });
}
/** Place a diagram's vertices as its layout would, without drawing: positions by vertex type. */
export async function arrange(
  gpu: Gpu,
  config: DiagramConfig,
  options: RequestOptions = {},
): Promise<Readonly<Record<string, Positions>>> {
  const data = checkedData(diagramData(config)),
    limits = resolveLimits(config.limits),
    style = resolveStyle(config, kit.resolveViewStyle(config, VIEW_DEFAULTS));
  const reader = gpu.reader.open({ signal: options.signal, at: config.at ?? undefined });
  try {
    const work = new Work(reader.signal, limits.layoutMs);
    const scene = await readScene(
      data,
      reader,
      style,
      limits,
      (input) => gpu.layoutText(input, { signal: reader.signal }),
      work,
    );
    await place(scene, layoutOptions(config.layout), style, work);
    work.check();
    return positions(scene.vertices);
  } finally {
    reader.close();
  }
}
/** The end flow leaves from: the first output, else the first end. */
export function rootEnd(edge: {
  readonly ends: readonly { readonly direction?: 'in' | 'out' }[];
}): number {
  return Math.max(
    0,
    edge.ends.findIndex((e) => e.direction === 'out'),
  );
}
/**
 * Place every vertex nothing pins, and find the scene's parts. Each group is arranged inside first
 * and then moves as one vertex of its parent; vertices drawn in `previous` stay where they were.
 */
export async function place(
  scene: Scene,
  layout: Required<LayoutOptions>,
  style: Style,
  work: Work,
  previous?: Scene,
): Promise<void> {
  work.check();
  keep(scene, previous);
  const placement = new Placement(scene, layout, style, work),
    { pieces, graph } = await placement.arrange(levels(scene));
  scene.parts = placement.parts(pieces, graph);
}
/** Pin each vertex drawn before where it was, so a new scene places only what is new. */
function keep(scene: Scene, previous?: Scene): void {
  if (!previous) return;
  const drawn = sceneRows(previous).vertices;
  for (const vertex of scene.vertices)
    if (!vertex.pinned) {
      const before = previous.vertices[drawn.get(sceneKey(vertex.hit)) ?? -1];
      if (before) {
        vertex.x = before.x;
        vertex.y = before.y;
        vertex.pinned = true;
      }
    }
}
/** The scene, or one of its groups, as layout descends it. */
interface Level {
  readonly group?: number;
  readonly vertices: number[];
  readonly children: Level[];
}
function levels(scene: Scene): Level {
  const root: Level = { vertices: [], children: [] },
    groups = new Map<string, Level>(
      scene.groups.map((group, g) => [group.id, { group: g, vertices: [], children: [] }]),
    );
  for (const group of scene.groups)
    ((group.parent && groups.get(group.parent)) || root).children.push(groups.get(group.id)!);
  scene.vertices.forEach((vertex, i) =>
    ((vertex.group && groups.get(vertex.group)) || root).vertices.push(i),
  );
  return root;
}
type Box = [number, number, number, number];
/** What layout moves as one: a vertex, or a group with everything inside it. */
interface Piece {
  readonly item: LayoutItem;
  /** The scene vertex it is; a group is none. */
  readonly vertex?: Vertex;
  /** Its first scene vertex in read order, which orders its level. */
  readonly first: number;
  readonly members: readonly number[];
  readonly groups: readonly number[];
  readonly pinned: boolean;
  /** The vertex's box, or the group's frame. */
  readonly bounds: Box;
  move(dx: number, dy: number): void;
}
class Placement {
  /** Each scene vertex's piece in the level being arranged; -1 outside it. */
  private readonly owner: Int32Array;
  /** The level that last took each edge, so each level takes it once. */
  private readonly taken: Int32Array;
  private readonly graph: kit.Graph;
  private level = 0;
  private readonly snap: (value: number) => number;
  constructor(
    private readonly scene: Scene,
    private readonly layout: Required<LayoutOptions>,
    private readonly style: Style,
    private readonly work: Work,
  ) {
    this.owner = new Int32Array(scene.vertices.length).fill(-1);
    this.taken = new Int32Array(scene.edges.length);
    this.graph = sceneGraph(scene);
    this.snap = (value) => Math.round(value / style.gridPitch) * style.gridPitch;
  }
  /** Arrange a level's pieces, each group's inside first; the graph joins them. */
  async arrange(level: Level): Promise<{ pieces: Piece[]; graph: kit.Graph }> {
    const pieces = level.vertices.map((i) => this.vertex(i));
    for (const child of level.children) {
      const inside = (await this.arrange(child)).pieces;
      if (inside.length) pieces.push(this.group(child.group!, inside));
    }
    // In read order, so parts number and pack by their first vertices.
    pieces.sort((a, b) => a.first - b.first);
    const { graph, input } = this.lift(pieces),
      at = await kit.place(graph, input, this.layout, this.work);
    pieces.forEach((piece, p) => {
      // Everything moves by whole grid steps, so what was on the grid stays on it.
      if (!piece.pinned)
        piece.move(
          this.snap(at[p * 2] - piece.bounds[0]),
          this.snap(at[p * 2 + 1] - piece.bounds[1]),
        );
    });
    return { pieces, graph };
  }
  /** The scene's parts from its own level's: every vertex, edge, and group inside each. */
  parts(pieces: readonly Piece[], graph: kit.Graph): Part[] {
    const { count, vertices: runs } = graph.parts,
      { scene } = this,
      out: Part[] = [];
    for (let k = 0; k < count; k++) {
      const inside = [...runs.items.subarray(runs.offsets[k], runs.offsets[k + 1])].map(
          (p) => pieces[p],
        ),
        vertices = inside.flatMap((piece) => piece.members).sort((a, b) => a - b),
        edges = new Set<number>();
      for (const v of vertices) for (const e of this.graph.edgesOf(v)) edges.add(e);
      out.push({
        key: sceneKey(scene.vertices[vertices[0]].hit),
        vertices,
        edges: [...edges].sort((a, b) => a - b),
        groups: inside.flatMap((piece) => piece.groups).sort((a, b) => a - b),
      });
    }
    return out;
  }
  private vertex(i: number): Piece {
    const vertex = this.scene.vertices[i],
      bounds: Box = [vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height];
    portPositions(vertex);
    return {
      item: rowOf(vertex.hit),
      vertex,
      first: i,
      members: [i],
      groups: [],
      pinned: vertex.pinned,
      bounds,
      move(dx, dy) {
        vertex.x += dx;
        vertex.y += dy;
        shift(bounds, dx, dy);
      },
    };
  }
  private group(g: number, inside: readonly Piece[]): Piece {
    const group = this.scene.groups[g],
      frame = groupFrame(
        union(inside.map((piece) => piece.bounds)),
        group,
        this.style.vertexPadding,
      ),
      bounds: Box = [frame[0], frame[1], frame[2], frame[3]];
    return {
      item: { kind: 'group', id: group.id },
      first: inside.reduce((first, piece) => Math.min(first, piece.first), Infinity),
      members: inside.flatMap((piece) => piece.members),
      groups: [g, ...inside.flatMap((piece) => piece.groups)],
      pinned: inside.some((piece) => piece.pinned),
      bounds,
      move(dx, dy) {
        for (const piece of inside) piece.move(dx, dy);
        shift(bounds, dx, dy);
      },
    };
  }
  /**
   * A level's pieces as layout reads them: the edges joining two or more, each end at the piece
   * holding its vertex, meeting a vertex at its port and a group at its center.
   */
  private lift(pieces: readonly Piece[]): { graph: kit.Graph; input: kit.LayoutInput } {
    const { owner, taken, scene, style, graph } = this,
      level = ++this.level,
      found: number[] = [];
    pieces.forEach((piece, p) => {
      for (const v of piece.members) {
        owner[v] = p;
        for (const e of graph.edgesOf(v))
          if (taken[e] !== level) {
            taken[e] = level;
            found.push(e);
          }
      }
    });
    const offsets = [0],
      ends: number[] = [],
      directions: number[] = [],
      ports: number[] = [],
      rooms: number[] = [];
    for (const e of found.sort((a, b) => a - b)) {
      const edge = scene.edges[e],
        first = ends.length;
      let joins = false;
      for (const end of edge.ends) {
        const p = owner[end.vertex];
        if (p < 0) continue;
        joins ||= p !== ends[first];
        ends.push(p);
        directions.push(end.direction === 'out' ? 1 : end.direction === 'in' ? -1 : 0);
        const vertex = pieces[p].vertex,
          port = end.port === null ? undefined : vertex?.ports.find((q) => q.name === end.port);
        if (port) ports.push(port.position[0] - vertex!.x, port.position[1] - vertex!.y);
        else ports.push(NaN, NaN);
      }
      if (!joins) {
        ends.length = directions.length = first;
        ports.length = first * 2;
        continue;
      }
      offsets.push(ends.length);
      rooms.push(...labelRoom(edge, style));
    }
    for (const piece of pieces) for (const v of piece.members) owner[v] = -1;
    const pinned = new Float64Array(pieces.length * 2).fill(NaN),
      sizes = new Float32Array(pieces.length * 2);
    pieces.forEach(({ pinned: fixed, bounds }, p) => {
      if (fixed) pinned.set([bounds[0], bounds[1]], p * 2);
      sizes.set([bounds[2] - bounds[0], bounds[3] - bounds[1]], p * 2);
    });
    return {
      graph: new kit.Graph(pieces.length, {
        offsets: Uint32Array.from(offsets),
        items: Uint32Array.from(ends),
      }),
      input: {
        pinned,
        sizes,
        directions: Int8Array.from(directions),
        ports: Float32Array.from(ports),
        labelRooms: Float32Array.from(rooms),
        grid: style.gridPitch,
        item: (p) => pieces[p].item,
      },
    };
  }
}
function shift(box: Box, dx: number, dy: number): void {
  box[0] += dx;
  box[1] += dy;
  box[2] += dx;
  box[3] += dy;
}
