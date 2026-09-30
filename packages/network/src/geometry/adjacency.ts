import { rowAt } from '@latkit/gpu';
import type { NetworkData, NetworkItem } from '../data.js';
import type { VertexBank, EdgeBank } from './connectivity.js';
import { RowLookup, indexKey } from './rows.js';

/** CSR adjacency over renderer-local dense addresses; public results always use native identities. */
export class Adjacency {
  readonly bytes: number;
  private readonly offsets: Uint32Array;
  private readonly incident: Uint32Array;
  private readonly edgeOffsets: Uint32Array;
  private readonly endpoints: Uint32Array;
  private readonly vertexRows = new Map<string, RowLookup<VertexBank>>();
  private readonly edgeRows = new Map<string, RowLookup<EdgeBank>>();
  constructor(
    private readonly vertices: readonly VertexBank[],
    private readonly edges: readonly EdgeBank[],
    vertexCount: number,
    edgeCount: number,
  ) {
    this.offsets = new Uint32Array(vertexCount + 1);
    this.edgeOffsets = new Uint32Array(edgeCount + 1);
    const all = new Uint32Array(edges.reduce((n, bank) => n + bank.incidence.vertices.length, 0));
    let written = 0;
    for (const bank of vertices) {
      const key = indexKey(bank.index);
      let rows = this.vertexRows.get(key);
      if (!rows) {
        rows = new RowLookup();
        this.vertexRows.set(key, rows);
      }
      rows.add(bank.rows, bank);
    }
    for (const rows of this.vertexRows.values()) rows.seal();
    for (const bank of edges) {
      const key = indexKey(bank.index);
      let rows = this.edgeRows.get(key);
      if (!rows) {
        rows = new RowLookup();
        this.edgeRows.set(key, rows);
      }
      rows.add(bank.rows, bank);
      for (let i = 0; i < bank.count; i++) {
        const start = bank.incidence.offsets[i],
          end = bank.incidence.offsets[i + 1],
          input = bank.incidence.vertices;
        const append = (vertex: number) => {
          all[written++] = vertex;
          this.offsets[vertex + 1]++;
        };
        if (end - start <= 2) {
          if (start < end) append(input[start]);
          if (start + 1 < end && input[start + 1] !== input[start]) append(input[start + 1]);
        } else for (const vertex of new Set(input.subarray(start, end))) append(vertex);
        this.edgeOffsets[bank.base + i + 1] = written;
      }
    }
    for (const rows of this.edgeRows.values()) rows.seal();
    this.endpoints = all;
    for (let i = 1; i < this.offsets.length; i++) this.offsets[i] += this.offsets[i - 1];
    this.incident = new Uint32Array(written);
    const fill = this.offsets.slice(0, vertexCount);
    for (let edge = 0; edge < edgeCount; edge++)
      for (let i = this.edgeOffsets[edge]; i < this.edgeOffsets[edge + 1]; i++)
        this.incident[fill[this.endpoints[i]]++] = edge;
    this.bytes =
      this.offsets.byteLength +
      this.edgeOffsets.byteLength +
      this.endpoints.byteLength +
      this.incident.byteLength;
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
      for (let i = this.edgeOffsets[dense]; i < this.edgeOffsets[dense + 1]; i++)
        addVertex(this.endpoints[i]);
    };
    const dense = found.value.base + found.offset;
    if (item.kind === 'edge') addEdge(dense);
    else
      for (let i = this.offsets[dense]; i < this.offsets[dense + 1]; i++) addEdge(this.incident[i]);
    return result;
  }
}
