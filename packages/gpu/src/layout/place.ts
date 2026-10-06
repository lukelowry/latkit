import { failure, type FieldValues, type Item, type Work } from '@latkit/model';
import type { Graph } from './graph.js';
import { layered } from './layered.js';
import { stress } from './stress.js';

/**
 * How a view places vertices without a position. Vertices that edges join form a part; each part is
 * arranged alone by `algorithm`, and the parts nothing pins pack into rows below the pinned ones.
 */
export interface LayoutOptions {
  /**
   * `layered` puts vertices in ranks along the flow; `stress` keeps graph distances, each edge
   * `vertexGap` long. A view defaults to the one that suits it.
   */
  readonly algorithm?: 'layered' | 'stress' | LayoutStrategy;
  /** `layered`: which way flow runs. Default: `'right'`. */
  readonly direction?: 'right' | 'left' | 'down' | 'up';
  /** Between vertices; `stress`: the length of an edge. */
  readonly vertexGap?: number;
  /** Between ranks, and between packed parts. */
  readonly rankGap?: number;
  /** `layered`: crossing-reduction passes, from 0 to 12. Default: 4. */
  readonly sweeps?: number;
  /** Width over height of the rows parts pack into. Default: 16 / 9. */
  readonly aspect?: number;
}
/** Where a type's vertices sit, an axis a field: spread into the type's options to keep them. */
export interface Positions {
  readonly x: FieldValues;
  readonly y: FieldValues;
}
/** What a vertex stands for: a row, or a diagram group. */
export type LayoutItem = Item | { readonly kind: 'group'; readonly id: string };
/** What layout reads beside the graph, each one a column: per vertex, per end, or per edge. */
export interface LayoutInput {
  /** Each vertex's top-left corner, two numbers a vertex; NaN where nothing pins it. */
  readonly pinned: Float64Array;
  /** Each vertex's width and height; points without. */
  readonly sizes?: Float32Array;
  /** Each end: 1 an output, -1 an input, 0 neither, in the order of the graph's ends. */
  readonly directions?: Int8Array;
  /** Where each end meets its vertex, from its top-left corner, two numbers an end; NaN its center. */
  readonly ports?: Float32Array;
  /** The room each edge's labels take between its ends, two numbers an edge. */
  readonly labelRooms?: Float32Array;
  /** Where placed corners and packed parts land: multiples of it; 0 anywhere. */
  readonly grid?: number;
  /** What each vertex stands for, for strategies of your own. */
  readonly item: (vertex: number) => LayoutItem;
}
/** One part of a graph, as a strategy arranges it. */
export interface LayoutPart {
  readonly graph: Graph;
  readonly input: LayoutInput;
  /** Its vertices, by index into the graph, in index order. */
  readonly vertices: Uint32Array;
  readonly edges: Uint32Array;
  /** A vertex's place in `vertices`; -1 outside the part. */
  indexOf(vertex: number): number;
  item(vertex: number): LayoutItem;
}
export interface LayoutStrategy {
  /** Each of a part's vertices' top-left corner, two numbers each; pinned ones where they are. */
  arrange(
    part: LayoutPart,
    context: { readonly signal: AbortSignal },
  ): ArrayLike<number> | Promise<ArrayLike<number>>;
}
const DIRECTIONS = ['right', 'left', 'down', 'up'];
/** Layout options over a view's defaults, checked. */
export function layoutOptions(
  layout: LayoutOptions = {},
  defaults: Required<Omit<LayoutOptions, 'direction' | 'sweeps' | 'aspect'>> &
    Partial<LayoutOptions>,
): Required<LayoutOptions> {
  if (typeof layout !== 'object' || layout === null)
    throw failure('invalid-input', 'Invalid layout options');
  const result = {
    algorithm: layout.algorithm ?? defaults.algorithm,
    direction: layout.direction ?? defaults.direction ?? 'right',
    vertexGap: layout.vertexGap ?? defaults.vertexGap,
    rankGap: layout.rankGap ?? defaults.rankGap,
    sweeps: layout.sweeps ?? defaults.sweeps ?? 4,
    aspect: layout.aspect ?? defaults.aspect ?? 16 / 9,
  };
  if (!Number.isInteger(result.sweeps) || result.sweeps < 0 || result.sweeps > 12)
    throw failure('invalid-input', 'Layout sweeps must be an integer from 0 to 12');
  for (const key of ['vertexGap', 'rankGap'] as const)
    if (!Number.isFinite(result[key]) || result[key] < 0)
      throw failure('invalid-input', 'Invalid ' + key);
  if (!(result.aspect > 0) || !Number.isFinite(result.aspect))
    throw failure('invalid-input', 'Invalid aspect');
  if (!DIRECTIONS.includes(result.direction))
    throw failure('invalid-input', 'Invalid layout direction');
  if (
    result.algorithm !== 'layered' &&
    result.algorithm !== 'stress' &&
    typeof result.algorithm?.arrange !== 'function'
  )
    throw failure('invalid-input', 'Invalid layout algorithm');
  return result;
}
/**
 * Where each vertex goes, two numbers a vertex: a pinned one where it is, and each part with a
 * vertex nothing pins arranged by the layout's strategy. Parts nothing pins pack into rows below
 * the pinned ones, tallest first, then by their first vertex, so like parts line up.
 */
export async function place(
  graph: Graph,
  input: LayoutInput,
  layout: Required<LayoutOptions>,
  work: Work,
): Promise<Float64Array> {
  work.check();
  const n = graph.vertexCount,
    at = Float64Array.from(input.pinned),
    parts = graph.parts,
    local = new Int32Array(n).fill(-1),
    grid = input.grid ?? 0,
    snap = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : v),
    strategy =
      layout.algorithm === 'layered'
        ? layered(layout, work)
        : layout.algorithm === 'stress'
          ? stress(layout, work)
          : layout.algorithm;
  const anchored = [Infinity, Infinity, -Infinity, -Infinity],
    loose: number[] = [];
  const pinned = (v: number) =>
    Number.isFinite(input.pinned[v * 2]) && Number.isFinite(input.pinned[v * 2 + 1]);
  for (let p = 0; p < parts.count; p++) {
    if ((p & 255) === 0) await work.step();
    const first = parts.vertices.offsets[p],
      last = parts.vertices.offsets[p + 1],
      vertices = parts.vertices.items.subarray(first, last);
    let free = 0;
    for (let i = first; i < last; i++) if (!pinned(parts.vertices.items[i])) free++;
    // A part of one vertex needs no arranging: it sits at its own corner until it packs.
    if (free && vertices.length === 1) at[vertices[0] * 2] = at[vertices[0] * 2 + 1] = 0;
    else if (free) {
      vertices.forEach((v, i) => (local[v] = i));
      const result = await strategy.arrange(
        {
          graph,
          input,
          vertices,
          edges: parts.edges.items.subarray(parts.edges.offsets[p], parts.edges.offsets[p + 1]),
          indexOf: (v) => local[v],
          item: input.item,
        },
        { signal: work.signal },
      );
      work.check();
      vertices.forEach((v) => (local[v] = -1));
      if (result?.length !== vertices.length * 2)
        throw failure('invalid-input', 'Layout returned invalid positions');
      for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i],
          x = result[i * 2],
          y = result[i * 2 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw failure('invalid-input', 'Layout returned invalid positions');
        if (pinned(v)) continue;
        at[v * 2] = snap(x);
        at[v * 2 + 1] = snap(y);
      }
    }
    if (free === vertices.length) loose.push(p);
    else for (const v of vertices) grow(anchored, box(at, input.sizes, v));
  }
  pack(graph, at, input.sizes, loose, anchored[0] <= anchored[2] ? anchored : null, layout, snap);
  return at;
}
type Box = [number, number, number, number];
function box(at: Float64Array, sizes: Float32Array | undefined, v: number): Box {
  const x = at[v * 2],
    y = at[v * 2 + 1];
  return [x, y, x + (sizes?.[v * 2] ?? 0), y + (sizes?.[v * 2 + 1] ?? 0)];
}
function grow(into: number[], b: Box): void {
  into[0] = Math.min(into[0], b[0]);
  into[1] = Math.min(into[1], b[1]);
  into[2] = Math.max(into[2], b[2]);
  into[3] = Math.max(into[3], b[3]);
}
/**
 * Loose parts in rows below what is pinned: tallest first, then by first vertex, so like parts
 * line up. Rows run about `aspect` times as wide as all the parts are tall, a rank gap apart.
 */
function pack(
  graph: Graph,
  at: Float64Array,
  sizes: Float32Array | undefined,
  loose: readonly number[],
  anchored: number[] | null,
  layout: Required<LayoutOptions>,
  snap: (value: number) => number,
): void {
  if (!loose.length) return;
  const { vertices } = graph.parts,
    gap = layout.rankGap,
    parts = loose
      .map((p) => {
        const bounds = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = vertices.offsets[p]; i < vertices.offsets[p + 1]; i++)
          grow(bounds, box(at, sizes, vertices.items[i]));
        return { p, bounds };
      })
      .sort(
        (a, b) =>
          b.bounds[3] - b.bounds[1] - (a.bounds[3] - a.bounds[1]) ||
          vertices.items[vertices.offsets[a.p]] - vertices.items[vertices.offsets[b.p]],
      );
  const width = (b: number[]) => b[2] - b[0],
    height = (b: number[]) => b[3] - b[1],
    area = parts.reduce(
      (sum, { bounds }) => sum + (width(bounds) + gap) * (height(bounds) + gap),
      0,
    ),
    span = Math.max(anchored ? width(anchored) : 0, Math.sqrt(area * layout.aspect)),
    left = anchored?.[0] ?? 0;
  let x = 0,
    y = anchored ? anchored[3] + gap : 0,
    row = 0;
  for (const { p, bounds } of parts) {
    if (x > 0 && x + width(bounds) > span) {
      x = 0;
      y += row + gap;
      row = 0;
    }
    const dx = snap(left + x - bounds[0]),
      dy = snap(y - bounds[1]);
    for (let i = vertices.offsets[p]; i < vertices.offsets[p + 1]; i++) {
      const v = vertices.items[i];
      at[v * 2] += dx;
      at[v * 2 + 1] += dy;
    }
    x += width(bounds) + gap;
    row = Math.max(row, height(bounds));
  }
}
