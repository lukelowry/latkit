import { Work, failure, type RequestOptions } from '@latkit/model';
import { kit, type Gpu } from '@latkit/gpu';
import {
  diagramData,
  rowOf,
  type DiagramItem,
  type DiagramRow,
  type Point,
  type Positions,
} from './data.js';
import type { DiagramConfig } from './diagram.js';
import {
  data as checkedData,
  resolveLimits,
  resolveStyle,
  positive,
  VIEW_DEFAULTS,
  type Style,
} from './config.js';
import { readScene } from './read.js';
import {
  positions,
  expand,
  intersects,
  union,
  groupFrame,
  sceneKey,
  type Part,
  type Rect,
  type Scene,
} from './scene.js';
import { labelRoom, portPositions } from './geometry.js';
/** A port as layout reads it: its side, and where it meets its vertex from the top-left corner. */
export interface LayoutPort {
  readonly name: string;
  readonly side: 'left' | 'right' | 'top' | 'bottom';
  readonly direction?: 'in' | 'out';
  readonly offset: Point;
}
/** A box layout places: a vertex, or a group arranged inside first, which moves as one. */
export interface LayoutVertex {
  /** The vertex row, or the group. */
  readonly item: DiagramItem;
  readonly size: Point;
  /** Its top-left corner while pinned, where it stays. */
  readonly position?: Point;
  readonly ports: readonly LayoutPort[];
}
export interface LayoutEdge {
  readonly item: DiagramRow;
  /** Each end's vertex in the part, and its port; a group's ends have none. */
  readonly ends: readonly {
    readonly vertex: number;
    readonly port: string | null;
    readonly direction?: 'in' | 'out';
  }[];
  /** The room its labels take between its ends: a wire's label, or a tag's past each stub. */
  readonly labelSize: Point;
}
/** One part of the diagram or of a group: vertices edges join, and those edges. */
export interface LayoutGraph {
  readonly vertices: readonly LayoutVertex[];
  readonly edges: readonly LayoutEdge[];
}
export interface LayoutStrategy {
  /** Each vertex's top-left corner, pinned ones where they are; parts pack afterwards. */
  arrange(
    part: LayoutGraph,
    context: { readonly signal: AbortSignal },
  ): readonly Point[] | Promise<readonly Point[]>;
}
/**
 * How vertices without a position are placed. Each part, a set of vertices edges join, is arranged
 * alone; the parts nothing pins then pack into rows below the pinned ones.
 */
export interface LayoutOptions {
  /** Arranges each part. Default: `'layered'`, in ranks along the flow. */
  readonly algorithm?: 'layered' | LayoutStrategy;
  readonly direction?: 'right' | 'left' | 'down' | 'up';
  readonly vertexGap?: number;
  /** Between ranks, and between packed parts. Default: 64. */
  readonly rankGap?: number;
  /** Crossing-reduction passes, from 0 to 12. Default: 4. */
  readonly sweeps?: number;
  /** Width over height of the rows parts pack into. Default: 16 / 9. */
  readonly aspect?: number;
}
export function layoutOptions(layout: LayoutOptions = {}): Required<LayoutOptions> {
  if (typeof layout !== 'object' || layout === null)
    throw failure('invalid-input', 'Invalid layout options');
  const result = {
    algorithm: layout.algorithm ?? 'layered',
    direction: layout.direction ?? 'right',
    vertexGap: layout.vertexGap ?? 24,
    rankGap: layout.rankGap ?? 64,
    sweeps: layout.sweeps ?? 4,
    aspect: layout.aspect ?? 16 / 9,
  };
  if (!Number.isInteger(result.sweeps) || result.sweeps < 0 || result.sweeps > 12)
    throw failure('invalid-input', 'Layout sweeps must be an integer from 0 to 12');
  positive(result.vertexGap, 'vertexGap', true);
  positive(result.rankGap, 'rankGap', true);
  positive(result.aspect, 'aspect');
  if (!['right', 'left', 'down', 'up'].includes(result.direction))
    throw failure('invalid-input', 'Invalid layout direction');
  if (result.algorithm !== 'layered' && typeof result.algorithm?.arrange !== 'function')
    throw failure('invalid-input', 'Invalid layout algorithm');
  return result;
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
  const strategy =
    layout.algorithm === 'layered' ? layered(layout, style.gridPitch, work) : layout.algorithm;
  await new Placement(scene, strategy, layout, style, work).arrange(levels(scene), true);
}
/** Pin each vertex drawn before where it was, so a new scene places only what is new. */
function keep(scene: Scene, previous?: Scene): void {
  if (!previous) return;
  const drawn = new Map(previous.vertices.map((vertex) => [sceneKey(vertex.hit), vertex]));
  for (const vertex of scene.vertices)
    if (!vertex.pinned) {
      const before = drawn.get(sceneKey(vertex.hit));
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
  readonly vertex: LayoutVertex;
  /** Its first scene vertex in read order, which orders packing. */
  readonly first: number;
  readonly members: readonly number[];
  readonly groups: readonly number[];
  readonly pinned: boolean;
  /** The vertex's box, or the group's frame. */
  readonly bounds: Box;
  move(dx: number, dy: number): void;
}
/** A part while it is placed: its pieces, and its edges among them. */
interface Split {
  readonly pieces: Piece[];
  readonly edges: LayoutEdge[];
}
/** An edge among a level's pieces: each end at the piece holding its vertex. */
interface Lifted {
  readonly edge: number;
  readonly ends: LayoutEdge['ends'][number][];
  /**
   * Whether flow enters the level through it. One whose source is outside keeps the pieces it
   * reaches in one part, but orders none of them before another.
   */
  readonly rooted: boolean;
}
class Placement {
  /** Each scene vertex's piece in the level being split; -1 outside it. */
  private readonly owner: Int32Array;
  /** Each vertex's edges: `incident` from `start[v]` to `start[v + 1]`. */
  private readonly start: Int32Array;
  private readonly incident: Int32Array;
  /** The level that last took each edge, so each level takes it once. */
  private readonly taken: Int32Array;
  private level = 0;
  private readonly snap: (value: number) => number;
  constructor(
    private readonly scene: Scene,
    private readonly strategy: LayoutStrategy,
    private readonly layout: Required<LayoutOptions>,
    private readonly style: Style,
    private readonly work: Work,
  ) {
    const n = scene.vertices.length;
    this.owner = new Int32Array(n).fill(-1);
    this.start = new Int32Array(n + 1);
    for (const edge of scene.edges) for (const end of edge.ends) this.start[end.vertex + 1]++;
    for (let v = 0; v < n; v++) this.start[v + 1] += this.start[v];
    this.incident = new Int32Array(this.start[n]);
    const fill = this.start.slice(0, n);
    scene.edges.forEach((edge, e) => {
      for (const end of edge.ends) this.incident[fill[end.vertex]++] = e;
    });
    this.taken = new Int32Array(scene.edges.length);
    this.snap = (value) => Math.round(value / style.gridPitch) * style.gridPitch;
  }
  /** Arrange a level's pieces part by part and pack its loose parts; the root records its parts. */
  async arrange(level: Level, root = false): Promise<Piece[]> {
    const pieces = level.vertices.map((i) => this.vertex(i));
    for (const child of level.children) {
      const inside = await this.arrange(child);
      if (inside.length) pieces.push(this.group(child.group!, inside));
    }
    const parts = this.split(pieces),
      anchored: Rect[] = [],
      loose: Piece[][] = [];
    for (const part of parts) {
      await this.work.step();
      if (part.pieces.some((piece) => !piece.pinned)) await this.place(part);
      if (part.pieces.some((piece) => piece.pinned))
        for (const piece of part.pieces) anchored.push(piece.bounds);
      else loose.push(part.pieces);
    }
    pack(loose, anchored.length ? union(anchored) : null, this.layout, this.snap);
    if (root) this.scene.parts = parts.map((part) => this.part(part));
    return pieces;
  }
  private async place(part: Split): Promise<void> {
    const at: readonly (readonly number[] | undefined)[] | undefined = await this.strategy.arrange(
      { vertices: part.pieces.map((piece) => piece.vertex), edges: part.edges },
      { signal: this.work.signal },
    );
    this.work.check();
    if (
      at?.length !== part.pieces.length ||
      at.some((p) => p?.length !== 2 || !p.every(Number.isFinite))
    )
      throw failure('invalid-input', 'Layout returned invalid positions');
    part.pieces.forEach((piece, i) => {
      if (piece.pinned) return;
      const dx = at[i]![0] - piece.bounds[0],
        dy = at[i]![1] - piece.bounds[1];
      // A group moves by whole grid steps, so what is inside stays on the grid.
      if (piece.vertex.item.kind === 'group') piece.move(this.snap(dx), this.snap(dy));
      else piece.move(dx, dy);
    });
  }
  private vertex(i: number): Piece {
    const vertex = this.scene.vertices[i],
      bounds: Box = [vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height];
    portPositions(vertex);
    return {
      vertex: {
        item: rowOf(vertex.hit),
        size: [vertex.width, vertex.height],
        ...(vertex.pinned ? { position: [vertex.x, vertex.y] as const } : {}),
        ports: vertex.ports.map((port) => ({
          name: port.name,
          side: port.side,
          ...(port.direction ? { direction: port.direction } : {}),
          offset: [port.position[0] - vertex.x, port.position[1] - vertex.y] as const,
        })),
      },
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
      bounds: Box = [frame[0], frame[1], frame[2], frame[3]],
      pinned = inside.some((piece) => piece.pinned);
    return {
      vertex: {
        item: { kind: 'group', id: group.id },
        size: [bounds[2] - bounds[0], bounds[3] - bounds[1]],
        ...(pinned ? { position: [bounds[0], bounds[1]] as const } : {}),
        ports: [],
      },
      first: inside.reduce((first, piece) => Math.min(first, piece.first), Infinity),
      members: inside.flatMap((piece) => piece.members),
      groups: [g, ...inside.flatMap((piece) => piece.groups)],
      pinned,
      bounds,
      move(dx, dy) {
        for (const piece of inside) piece.move(dx, dy);
        shift(bounds, dx, dy);
      },
    };
  }
  /** A level's parts, in the order of their first pieces, with their edges renumbered into each. */
  private split(pieces: readonly Piece[]): Split[] {
    const lifted = this.lift(pieces),
      root = Int32Array.from(pieces, (_, i) => i);
    const find = (i: number) => {
      while (root[i] !== i) i = root[i] = root[root[i]];
      return i;
    };
    for (const { ends } of lifted)
      for (const end of ends) root[find(end.vertex)] = find(ends[0].vertex);
    const at = new Int32Array(pieces.length),
      parts = new Map<number, Split>();
    pieces.forEach((piece, i) => {
      let part = parts.get(find(i));
      if (!part) parts.set(find(i), (part = { pieces: [], edges: [] }));
      at[i] = part.pieces.push(piece) - 1;
    });
    for (const { edge, ends, rooted } of lifted) {
      if (!rooted) continue;
      const drawn = this.scene.edges[edge];
      parts.get(find(ends[0].vertex))!.edges.push({
        item: rowOf(drawn.hit),
        ends: ends.map((end) => ({ ...end, vertex: at[end.vertex] })),
        labelSize: labelRoom(drawn, this.style),
      });
    }
    return [...parts.values()];
  }
  /** The edges joining a level's pieces: ends outside them are left out, and ports of groups. */
  private lift(pieces: readonly Piece[]): Lifted[] {
    const { owner, start, incident, taken, scene } = this,
      level = ++this.level,
      found: number[] = [];
    pieces.forEach((piece, p) => {
      for (const v of piece.members) {
        owner[v] = p;
        for (let k = start[v]; k < start[v + 1]; k++)
          if (taken[incident[k]] !== level) {
            taken[incident[k]] = level;
            found.push(incident[k]);
          }
      }
    });
    const lifted: Lifted[] = [];
    for (const e of found.sort((a, b) => a - b)) {
      const ends: Lifted['ends'] = [];
      let joins = false;
      for (const end of scene.edges[e].ends) {
        const p = owner[end.vertex];
        if (p < 0) continue;
        ends.push({
          vertex: p,
          port: pieces[p].vertex.item.kind === 'group' ? null : end.port,
          ...(end.direction ? { direction: end.direction } : {}),
        });
        joins ||= p !== ends[0].vertex;
      }
      if (joins) {
        const root = scene.edges[e].ends[rootEnd(scene.edges[e])];
        lifted.push({ edge: e, ends, rooted: owner[root.vertex] >= 0 });
      }
    }
    for (const piece of pieces) for (const v of piece.members) owner[v] = -1;
    return lifted;
  }
  /** A root part as the scene keeps it: every vertex, edge, and group inside. */
  private part(split: Split): Part {
    const { start, incident, scene } = this,
      vertices = split.pieces.flatMap((piece) => piece.members).sort((a, b) => a - b),
      edges = new Set<number>();
    for (const v of vertices) for (let k = start[v]; k < start[v + 1]; k++) edges.add(incident[k]);
    return {
      key: sceneKey(scene.vertices[vertices[0]].hit),
      vertices,
      edges: [...edges].sort((a, b) => a - b),
      groups: split.pieces.flatMap((piece) => piece.groups).sort((a, b) => a - b),
    };
  }
}
function shift(box: Box, dx: number, dy: number): void {
  box[0] += dx;
  box[1] += dy;
  box[2] += dx;
  box[3] += dy;
}
const width = (box: Rect) => box[2] - box[0],
  height = (box: Rect) => box[3] - box[1];
/**
 * Loose parts in rows below what is pinned: tallest first, then in read order, so like parts line
 * up. Rows run about `aspect` times as wide as all the parts are tall, a rank gap apart.
 */
function pack(
  loose: readonly (readonly Piece[])[],
  anchored: Rect | null,
  layout: Required<LayoutOptions>,
  snap: (value: number) => number,
): void {
  if (!loose.length) return;
  const gap = layout.rankGap,
    parts = loose
      .map((pieces) => ({
        pieces,
        box: union(pieces.map((piece) => piece.bounds)),
        first: pieces.reduce((first, piece) => Math.min(first, piece.first), Infinity),
      }))
      .sort((a, b) => height(b.box) - height(a.box) || a.first - b.first);
  const area = parts.reduce((sum, { box }) => sum + (width(box) + gap) * (height(box) + gap), 0),
    span = Math.max(anchored ? width(anchored) : 0, Math.sqrt(area * layout.aspect)),
    left = anchored?.[0] ?? 0;
  let x = 0,
    y = anchored ? anchored[3] + gap : 0,
    row = 0;
  for (const { pieces, box } of parts) {
    if (x > 0 && x + width(box) > span) {
      x = 0;
      y += row + gap;
      row = 0;
    }
    const dx = snap(left + x - box[0]),
      dy = snap(y - box[1]);
    for (const piece of pieces) piece.move(dx, dy);
    x += width(box) + gap;
    row = Math.max(row, height(box));
  }
}
/** The built-in strategy: ranks along the flow, ordered to cross less, each vertex in line with its sources' ports. */
function layered(layout: Required<LayoutOptions>, grid: number, work: Work): LayoutStrategy {
  return { arrange: (part) => ranked(part, layout, grid, work) };
}
async function ranked(
  part: LayoutGraph,
  layout: Required<LayoutOptions>,
  grid: number,
  work: Work,
): Promise<Point[]> {
  const { vertices, edges } = part,
    n = vertices.length,
    xs = Float64Array.from(vertices, (vertex) => vertex.position?.[0] ?? 0),
    ys = Float64Array.from(vertices, (vertex) => vertex.position?.[1] ?? 0);
  // Flow runs from each of an edge's outputs to each of its other ends, or from its first end when
  // it has no output; outputs that merge into one net order none of themselves.
  const links: { a: number; b: number; from: string | null; to: string | null }[] = [];
  for (const edge of edges) {
    const root = rootEnd(edge),
      sources = edge.ends.filter((end, i) => end.direction === 'out' || i === root);
    for (const source of sources)
      for (const end of edge.ends)
        if (end.vertex !== source.vertex && !sources.includes(end))
          links.push({ a: source.vertex, b: end.vertex, from: source.port, to: end.port });
  }
  const next = Array.from({ length: n }, () => [] as number[]),
    back = Array.from({ length: n }, () => [] as number[]);
  for (const { a, b } of links) {
    next[a].push(b);
    back[b].push(a);
  }
  for (const list of next) list.sort((a, b) => a - b);
  // Iterative DFS classifies feedback edges without collapsing an entire cycle into one column.
  // Topology remains intact; only ranking ignores back edges.
  const color = new Uint8Array(n),
    forward = Array.from({ length: n }, () => [] as number[]);
  const roots = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => Number(back[a].length > 0) - Number(back[b].length > 0) || a - b,
  );
  for (const root of roots)
    if (!color[root]) {
      const stack: [number, number][] = [[root, 0]];
      color[root] = 1;
      while (stack.length) {
        await work.step();
        const top = stack[stack.length - 1],
          a = top[0];
        if (top[1] === next[a].length) {
          color[a] = 2;
          stack.pop();
          continue;
        }
        const b = next[a][top[1]++];
        if (color[b] === 1) continue;
        forward[a].push(b);
        if (!color[b]) {
          color[b] = 1;
          stack.push([b, 0]);
        }
      }
    }
  const degree = new Uint32Array(n),
    rank = new Uint32Array(n);
  for (const list of forward) for (const b of list) degree[b]++;
  const queue = roots.filter((i) => !degree[i]);
  for (let i = 0; i < queue.length; i++)
    for (const b of forward[queue[i]]) {
      rank[b] = Math.max(rank[b], rank[queue[i]] + 1);
      if (!--degree[b]) queue.push(b);
    }
  const ranks = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const list = ranks.get(rank[i]) ?? [];
    list.push(i);
    ranks.set(rank[i], list);
  }
  const ordered = [...ranks].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  const slots = new Float64Array(n);
  const score = (i: number, neighbors: readonly number[]) => {
    if (!neighbors.length) return slots[i];
    return neighbors.reduce((sum, other) => sum + slots[other], 0) / neighbors.length;
  };
  // Bounded alternating barycenter sweeps reduce crossings.
  for (let sweep = 0; sweep < layout.sweeps; sweep++) {
    await work.step();
    for (const list of ordered)
      list.forEach((i, position) => {
        slots[i] = position;
      });
    for (const list of sweep % 2 ? [...ordered].reverse() : ordered) {
      const scores = new Map(list.map((i) => [i, score(i, (sweep % 2 ? next : back)[i])]));
      list.sort((a, b) => scores.get(a)! - scores.get(b)! || a - b);
      list.forEach((i, position) => {
        slots[i] = position;
      });
    }
  }
  const vertical = layout.direction === 'down' || layout.direction === 'up',
    reverse = layout.direction === 'left' || layout.direction === 'up',
    half = layout.vertexGap / 2,
    box = (i: number): Rect =>
      expand([xs[i], ys[i], xs[i] + vertices[i].size[0], ys[i] + vertices[i].size[1]], half);
  // Placed boxes in a uniform grid of their own, for the collision escape below.
  const placedBoxes: Rect[] = [],
    cells = new Map<number, number[]>(),
    cell = 256;
  const cellsOf = (box: Rect, visit: (key: number) => void) => {
    for (let y = Math.floor(box[1] / cell); y <= Math.floor(box[3] / cell); y++)
      for (let x = Math.floor(box[0] / cell); x <= Math.floor(box[2] / cell); x++)
        visit((x + 0x2000000) * 0x4000000 + (y + 0x2000000));
  };
  const occupy = (box: Rect) => {
    const id = placedBoxes.push(box) - 1;
    cellsOf(box, (key) => {
      const bucket = cells.get(key);
      if (bucket) bucket.push(id);
      else cells.set(key, [id]);
    });
  };
  const hits = (box: Rect) => {
    const found = new Set<number>();
    cellsOf(box, (key) => {
      for (const id of cells.get(key) ?? []) if (intersects(placedBoxes[id], box)) found.add(id);
    });
    return [...found];
  };
  for (let i = 0; i < n; i++) if (vertices[i].position) occupy(box(i));
  // Each port's offset across the flow, so wires between ports can run straight.
  const across = (i: number, port: string | null) => {
    const found = port ? vertices[i].ports.find((p) => p.name === port) : undefined;
    return found ? found.offset[vertical ? 0 : 1] : vertices[i].size[vertical ? 0 : 1] / 2;
  };
  const incoming = Array.from({ length: n }, () => [] as (typeof links)[number][]);
  for (const link of links) incoming[link.b].push(link);
  const placed = Uint8Array.from(vertices, (vertex) => +!!vertex.position);
  const labelGaps = new Float64Array(n);
  for (const edge of edges) {
    const root = edge.ends[rootEnd(edge)];
    if (root)
      labelGaps[root.vertex] = Math.max(
        labelGaps[root.vertex],
        edge.labelSize[vertical ? 1 : 0] + grid * 3,
      );
  }
  let major = 0;
  for (const list of ordered) {
    await work.step();
    // A rank holding pinned vertices starts where they stand, so new vertices join them.
    let start = reverse ? -Infinity : Infinity;
    for (const i of list)
      if (vertices[i].position) {
        const at = vertical ? ys[i] : xs[i];
        start = reverse
          ? Math.max(start, at + vertices[i].size[vertical ? 1 : 0])
          : Math.min(start, at);
      }
    if (Number.isFinite(start)) major = reverse ? -start : start;
    let minor = 0,
      max = 0;
    for (const i of list) {
      const [width, height] = vertices[i].size,
        along = vertical ? height : width,
        span = vertical ? width : height;
      max = Math.max(max, along);
      if (vertices[i].position) continue;
      const a = reverse ? -major - along : major;
      // Where each placed source would have this vertex sit for their ports to line up.
      const wanted = incoming[i]
        .filter((link) => placed[link.a])
        .map(
          (link) =>
            (vertical ? xs[link.a] : ys[link.a]) + across(link.a, link.from) - across(i, link.to),
        )
        .sort((a, b) => a - b);
      let b = Math.max(minor, wanted.length ? wanted[(wanted.length - 1) >> 1] : minor);
      xs[i] = vertical ? b : a;
      ys[i] = vertical ? a : b;
      // Deterministic local collision escape; jump beyond obstacles, never scan huge coordinates.
      for (let attempt = 0; attempt <= n; attempt++) {
        const found = hits(box(i));
        if (!found.length) break;
        b = Math.max(...found.map((j) => placedBoxes[j][vertical ? 2 : 3])) + layout.vertexGap;
        xs[i] = vertical ? b : a;
        ys[i] = vertical ? a : b;
        if (attempt === n) throw failure('resource-limit', 'Layout collision budget exceeded');
      }
      xs[i] = Math.round(xs[i] / grid) * grid;
      ys[i] = Math.round(ys[i] / grid) * grid;
      occupy(box(i));
      placed[i] = 1;
      minor = b + span + layout.vertexGap;
    }
    const labelGap = list.reduce((gap, i) => Math.max(gap, labelGaps[i]), 0);
    major += max + Math.max(layout.rankGap, labelGap);
  }
  return Array.from({ length: n }, (_, i) => [xs[i], ys[i]] as const);
}
