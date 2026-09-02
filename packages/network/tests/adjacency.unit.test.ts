import { describe, expect, it } from 'vitest';

import { adjacency, neighborhood } from '../src/topology/adjacency.js';
import type { Topology } from '../src/index.js';

/** Three vertices: 0-1, 1-2, a self-loop on 2, and one edge whose far endpoint is out of range. */
const TOPOLOGY: Topology = {
  vertexCount: 3,
  edges: Uint32Array.of(0, 1, 1, 2, 2, 2, 1, 9),
  polylineStart: new Uint32Array(5),
};

describe('adjacency', () => {
  it('counts a self-loop once and skips an out-of-range endpoint', () => {
    const built = adjacency(TOPOLOGY);
    expect([...built.offsets]).toEqual([0, 1, 4, 6]);
    expect([...built.incident.subarray(0, 1)]).toEqual([0]);
    expect([...built.incident.subarray(1, 4)]).toEqual([0, 1, 3]);
    expect([...built.incident.subarray(4, 6)]).toEqual([1, 2]);
  });

  it('pairs an edge with both endpoints and a vertex with its incident frontier', () => {
    const built = adjacency(TOPOLOGY);
    expect(neighborhood(built, { kind: 'edge', index: 0 })).toEqual([
      { kind: 'edge', index: 0 },
      { kind: 'vertex', index: 0 },
      { kind: 'vertex', index: 1 },
    ]);
    expect(neighborhood(built, { kind: 'edge', index: 2 })).toEqual([
      { kind: 'edge', index: 2 },
      { kind: 'vertex', index: 2 },
    ]);
    expect(neighborhood(built, { kind: 'vertex', index: 0 })).toEqual([
      { kind: 'vertex', index: 0 },
      { kind: 'edge', index: 0 },
      { kind: 'vertex', index: 1 },
    ]);
  });
});
