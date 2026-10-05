import { rowAt } from '@latkit/model';
import { kit } from '@latkit/gpu';

import type { NetworkData, NetworkItem } from '../data.js';
import type { VertexBank, EdgeBank } from './topology.js';
import { RowLookup, indexKey } from './rows.js';

/**
 * The drawn graph over renderer-local dense addresses: vertices, then edges, then paths. Public
 * results always use native identities.
 */
export class Adjacency {
  readonly bytes: number;
  /** Vertices, and edges by the vertices each joins once; paths join none. */
  readonly graph: kit.Graph;
  private readonly vertexRows = new Map<string, RowLookup<VertexBank>>();
  private readonly edgeRows = new Map<string, RowLookup<EdgeBank>>();
  constructor(
    private readonly vertices: readonly VertexBank[],
    private readonly edges: readonly EdgeBank[],
    paths: readonly EdgeBank[],
    private readonly vertexCount: number,
    edgeCount: number,
  ) {
    const offsets = new Uint32Array(edgeCount + 1),
      ends = new Uint32Array(edges.reduce((n, bank) => n + bank.incidence.vertices.length, 0));
    let written = 0;
    for (const bank of vertices) this.rows(this.vertexRows, bank.index).add(bank.rows, bank);
    for (const rows of this.vertexRows.values()) rows.seal();
    for (const bank of edges) {
      this.rows(this.edgeRows, bank.index).add(bank.rows, bank);
      const input = bank.incidence.vertices;
      for (let i = 0; i < bank.count; i++) {
        const start = bank.incidence.offsets[i],
          end = bank.incidence.offsets[i + 1];
        if (end - start <= 2) {
          if (start < end) ends[written++] = input[start];
          if (start + 1 < end && input[start + 1] !== input[start])
            ends[written++] = input[start + 1];
        } else for (const vertex of new Set(input.subarray(start, end))) ends[written++] = vertex;
        offsets[bank.base + i + 1] = written;
      }
    }
    for (const bank of paths) this.rows(this.edgeRows, bank.index).add(bank.rows, bank);
    for (const rows of this.edgeRows.values()) rows.seal();
    this.graph = new kit.Graph(vertexCount, {
      offsets,
      items: written === ends.length ? ends : ends.slice(0, written),
    });
    // Found now, so neighborhoods never wait on it and its bytes count toward the geometry.
    void this.graph.incident;
    this.bytes = this.graph.bytes;
  }
  private rows<T>(map: Map<string, RowLookup<T>>, index: VertexBank['index']): RowLookup<T> {
    const key = indexKey(index);
    let rows = map.get(key);
    if (!rows) map.set(key, (rows = new RowLookup()));
    return rows;
  }
  /** An item's dense address, or undefined when it is not drawn. */
  address(item: NetworkItem): number | undefined {
    if (item.kind === 'vertex') {
      const found = this.vertexRows.get(indexKey(item.index))?.get(item.row);
      return found && found.value.base + found.offset;
    }
    const found = this.edgeRows.get(indexKey(item.index))?.get(item.row);
    return found && this.vertexCount + found.value.base + found.offset;
  }
  private bank<T extends { readonly base: number; readonly count: number }>(
    banks: readonly T[],
    row: number,
  ): T | undefined {
    let lo = 0,
      hi = banks.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (banks[m].base <= row) lo = m + 1;
      else hi = m;
    }
    const b = banks[lo - 1];
    return b && row < b.base + b.count ? b : undefined;
  }
  neighborhood(item: NetworkItem, data: NetworkData): readonly NetworkItem[] {
    if (item.source !== data.source || item.kind === 'path') return [];
    const found = (item.kind === 'vertex' ? this.vertexRows : this.edgeRows)
      .get(indexKey(item.index))
      ?.get(item.row);
    if (!found) return [];
    const result: NetworkItem[] = [item],
      seen = new Set<string>([item.kind + ':' + item.index.type + ':' + item.row]);
    const addVertex = (dense: number) => {
      if (dense === 0xffffffff) return;
      const bank = this.bank(this.vertices, dense);
      if (!bank) return;
      const row = rowAt(bank.rows, dense - bank.base),
        key = 'vertex:' + bank.type + ':' + row;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ kind: 'vertex', source: data.source, index: bank.index, row });
      }
    };
    const addEdge = (dense: number) => {
      const bank = this.bank(this.edges, dense)!;
      const row = rowAt(bank.rows, dense - bank.base),
        key = 'edge:' + bank.type + ':' + row;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ kind: 'edge', source: data.source, index: bank.index, row });
      }
      for (const vertex of this.graph.endsOf(dense)) addVertex(vertex);
    };
    const dense = found.value.base + found.offset;
    if (item.kind === 'edge') addEdge(dense);
    else for (const edge of this.graph.edgesOf(dense)) addEdge(edge);
    return result;
  }
}
