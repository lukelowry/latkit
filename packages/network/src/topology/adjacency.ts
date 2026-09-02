/**
 * A topology's adjacency and the neighborhood an item is framed with: built once per loaded
 * topology so `Network.neighborhood` answers without a scan.
 */

import type { Item } from '@latkit/model';
import type { Topology } from './types.js';

/** Incident edges per vertex: CSR over a topology's edge pairs. */
export interface Adjacency {
  /** The topology's edge pairs, as loaded. */
  readonly edges: Uint32Array;
  /** `offsets[v]..offsets[v + 1]` index `incident` for vertex `v`. */
  readonly offsets: Uint32Array;
  /** Edge indices, grouped by vertex. */
  readonly incident: Uint32Array;
}

/**
 * Build a topology's adjacency in two passes over its edge pairs: degrees into `offsets`, then
 * each vertex's incident edges. An endpoint outside the vertex range is skipped; a self-loop
 * counts once.
 */
export function adjacency(topology: Topology): Adjacency {
  const { edges, vertexCount } = topology;
  const edgeCount = Math.floor(edges.length / 2);
  const offsets = new Uint32Array(vertexCount + 1);
  const eachEndpoint = (visit: (vertex: number, edge: number) => void): void => {
    for (let edge = 0; edge < edgeCount; edge++) {
      const from = edges[edge * 2]!;
      const to = edges[edge * 2 + 1]!;
      if (from < vertexCount) visit(from, edge);
      if (to !== from && to < vertexCount) visit(to, edge);
    }
  };
  eachEndpoint((vertex) => {
    offsets[vertex + 1] = offsets[vertex + 1]! + 1;
  });
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    offsets[vertex + 1] = offsets[vertex + 1]! + offsets[vertex]!;
  }
  const incident = new Uint32Array(offsets[vertexCount]!);
  const fill = offsets.slice(0, vertexCount);
  eachEndpoint((vertex, edge) => {
    const at = fill[vertex]!;
    incident[at] = edge;
    fill[vertex] = at + 1;
  });
  return { edges, offsets, incident };
}

/**
 * The item plus what touches it: an edge with both endpoints, a vertex with its incident edges
 * and their far ends.
 */
export function neighborhood(within: Adjacency, item: Item): Item[] {
  const items: Item[] = [item];
  const { edges, offsets, incident } = within;
  if (item.kind === 'edge') {
    const from = edges[item.index * 2];
    const to = edges[item.index * 2 + 1];
    if (from !== undefined) items.push({ kind: 'vertex', index: from });
    if (to !== undefined && to !== from) items.push({ kind: 'vertex', index: to });
    return items;
  }
  const start = offsets[item.index];
  const end = offsets[item.index + 1];
  if (start === undefined || end === undefined) return items;
  for (let at = start; at < end; at++) {
    const edge = incident[at]!;
    const from = edges[edge * 2]!;
    const to = edges[edge * 2 + 1]!;
    items.push(
      { kind: 'edge', index: edge },
      { kind: 'vertex', index: from === item.index ? to : from },
    );
  }
  return items;
}
