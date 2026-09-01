import type { Topology } from '../../src/topology/index.js';

export function sampleTopology(overrides: Partial<Topology> = {}): Topology {
  const topology: Topology = {
    vertexCount: 3,
    vertexCoords: new Float32Array([0, 0, 10, 0, 20, 10]),
    edges: new Uint32Array([0, 1, 1, 2]),
    polylineStart: new Uint32Array([0, 0, 2]),
    polylinePoints: new Float32Array([12, 2, 18, 4]),
  };
  return { ...topology, ...overrides };
}

export function singleEdgeTopology(): Topology {
  return {
    vertexCount: 2,
    vertexCoords: new Float32Array([0, 0, 1, 1]),
    edges: new Uint32Array([0, 1]),
    polylineStart: new Uint32Array([0, 0]),
    polylinePoints: new Float32Array(0),
  };
}

export function geographicTopology(): Topology {
  return sampleTopology({
    vertexCoords: new Float32Array([-10, -5, 0, 5, 10, -4]),
    polylinePoints: new Float32Array([3, 4, 7, 0]),
  });
}

/** Topology without caller-supplied coordinates: renders on the generated unit ring. */
export function ringTopology(): Topology {
  return {
    vertexCount: 3,
    edges: new Uint32Array([0, 1, 1, 2]),
    polylineStart: new Uint32Array([0, 0, 0]),
  };
}

export function nonGlobeTopology(): Topology {
  return sampleTopology({
    vertexCoords: new Float32Array([190, 0, 200, 4, 210, -3]),
    polylinePoints: new Float32Array([202, 2, 206, 1]),
  });
}
