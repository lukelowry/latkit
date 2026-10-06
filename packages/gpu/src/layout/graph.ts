/**
 * Vertices edges join, as runs of indices: run p holds `items[offsets[p]]` up to
 * `items[offsets[p + 1]]`.
 */
export interface Runs {
  readonly offsets: Uint32Array;
  readonly items: Uint32Array;
}
/** A graph's parts: vertices that edges join, each part's in index order, parts by first vertex. */
export interface Parts {
  readonly count: number;
  readonly vertices: Runs;
  readonly edges: Runs;
  /** Each vertex's part. */
  readonly of: Uint32Array;
}
/**
 * A drawn graph: vertices by index, and each edge as the run of vertices it joins. A view builds
 * one per topology; each vertex's edges and the graph's parts are found once, when first asked for.
 */
export class Graph {
  #edgesOf?: Runs;
  #parts?: Parts;
  readonly edgeCount: number;
  constructor(
    readonly vertexCount: number,
    /** Each edge's vertices. */
    readonly ends: Runs,
  ) {
    this.edgeCount = ends.offsets.length - 1;
  }
  /** The vertices edge `e` joins. */
  endsOf(e: number): Uint32Array {
    return this.ends.items.subarray(this.ends.offsets[e], this.ends.offsets[e + 1]);
  }
  /** The edges with an end at vertex `v`. */
  edgesOf(v: number): Uint32Array {
    const { offsets, items } = this.incident;
    return items.subarray(offsets[v], offsets[v + 1]);
  }
  /** Each vertex's edges, once for each end it has on one. */
  get incident(): Runs {
    if (this.#edgesOf) return this.#edgesOf;
    const { offsets: start, items: ends } = this.ends,
      offsets = new Uint32Array(this.vertexCount + 1);
    for (let i = 0; i < ends.length; i++) offsets[ends[i] + 1]++;
    for (let v = 0; v < this.vertexCount; v++) offsets[v + 1] += offsets[v];
    const items = new Uint32Array(ends.length),
      fill = offsets.slice(0, this.vertexCount);
    for (let e = 0; e < this.edgeCount; e++)
      for (let i = start[e]; i < start[e + 1]; i++) items[fill[ends[i]]++] = e;
    return (this.#edgesOf = { offsets, items });
  }
  /** Vertices edges join; an edge without ends joins none. */
  get parts(): Parts {
    if (this.#parts) return this.#parts;
    const n = this.vertexCount,
      root = new Uint32Array(n);
    for (let v = 0; v < n; v++) root[v] = v;
    const find = (v: number) => {
      while (root[v] !== v) v = root[v] = root[root[v]];
      return v;
    };
    const { offsets: start, items: ends } = this.ends;
    for (let e = 0; e < this.edgeCount; e++)
      for (let i = start[e] + 1; i < start[e + 1]; i++) {
        const a = find(ends[start[e]]),
          b = find(ends[i]);
        // The lower root wins, so a part's root is its first vertex.
        if (a < b) root[b] = a;
        else if (b < a) root[a] = b;
      }
    const of = new Uint32Array(n),
      number = new Int32Array(n).fill(-1);
    let count = 0;
    for (let v = 0; v < n; v++) {
      const r = find(v);
      if (number[r] < 0) number[r] = count++;
      of[v] = number[r];
    }
    const vertices = runs(count, n, (visit) => {
      for (let v = 0; v < n; v++) visit(of[v], v);
    });
    const edges = runs(count, this.edgeCount, (visit) => {
      for (let e = 0; e < this.edgeCount; e++)
        if (start[e] < start[e + 1]) visit(of[ends[start[e]]], e);
    });
    return (this.#parts = { count, vertices, edges, of });
  }
  /** Bytes held, counting what was found on asking. */
  get bytes(): number {
    const sum = (r?: Runs) => (r ? r.offsets.byteLength + r.items.byteLength : 0);
    return (
      sum(this.ends) +
      sum(this.#edgesOf) +
      (this.#parts
        ? sum(this.#parts.vertices) + sum(this.#parts.edges) + this.#parts.of.byteLength
        : 0)
    );
  }
}
/** Group items into runs by a key from 0 to `count`, keeping their order within each. */
function runs(
  count: number,
  size: number,
  each: (visit: (key: number, item: number) => void) => void,
): Runs {
  const offsets = new Uint32Array(count + 1);
  let total = 0;
  each((key) => {
    offsets[key + 1]++;
    total++;
  });
  for (let k = 0; k < count; k++) offsets[k + 1] += offsets[k];
  const items = new Uint32Array(Math.min(total, size)),
    fill = offsets.slice(0, count);
  each((key, item) => {
    items[fill[key]++] = item;
  });
  return { offsets, items };
}
