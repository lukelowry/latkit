import type { Topology } from '@latkit/network';
import { makeFakeNetwork } from './fake-network.js';

/**
 * A topology plus the per-vertex signals that drive the color/size channels.
 * `size` is optional: a topology that reads better at a uniform vertex size
 * simply omits it, and the host clears the vertexSize channel on switch.
 */
export interface GeneratedTopology {
  readonly topology: Topology;
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** Per-vertex scalar in [0, 1] for the vertexColor channel. */
  readonly color: Float32Array;
  /** Per-vertex scalar in [0, 1] for the vertexSize channel; omitted when uniform. */
  readonly size?: Float32Array;
}

/** One entry in the topology chooser: a label and a lazy builder. */
export interface TopologyOption {
  readonly id: string;
  readonly label: string;
  readonly build: () => GeneratedTopology;
}

export const TOPOLOGIES: readonly TopologyOption[] = [
  { id: 'power-grid', label: 'power grid', build: powerGrid },
  { id: 'grid', label: 'grid', build: grid },
  { id: 'grid-100k', label: 'grid 100k', build: grid100k },
];

/** The existing synthetic power grid (nearest-neighbour mesh + bent corridors). */
function powerGrid(): GeneratedTopology {
  const f = makeFakeNetwork();
  return {
    topology: f.topology,
    vertexCount: f.vertexCount,
    edgeCount: f.edgeCount,
    color: f.load,
    size: f.degree,
  };
}

/**
 * A small square lattice with three long diagonal geodesics for the globe
 * benchmark. Each vertex connects to its right and down neighbour (so rows and
 * columns curve as lat/lon lines on the sphere), and the three geodesics span
 * the box as long great-circle arcs. 30 vertices, 52 edges.
 */
function grid(): GeneratedTopology {
  return buildGrid({
    cols: 6,
    rows: 5,
    lonMin: -55,
    lonMax: 55,
    latMin: -38,
    latMax: 38,
    // [c0, r0, c1, r1]
    geodesics: [
      [0, 2, 5, 2], // ~110 deg equatorial span
      [0, 0, 5, 4], // diagonal
      [5, 0, 0, 4], // anti-diagonal
    ],
  });
}

/**
 * A dense ~100k-vertex square lattice over a wide lon/lat box for the scale
 * stress test (interactive retessellation on camera move, GPU pick latency at
 * ~200k edges). Grid-mesh edges plus a handful of box-spanning geodesics.
 * Built in O(vertexCount): grid neighbours are O(1) per vertex.
 */
function grid100k(): GeneratedTopology {
  const cols = 400;
  const rows = 250; // 100,000 vertices
  const midC = cols >> 1;
  const midR = rows >> 1;
  const qR = rows >> 2;
  return buildGrid({
    cols,
    rows,
    lonMin: -160,
    lonMax: 160,
    latMin: -80,
    latMax: 80,
    geodesics: [
      [0, 0, cols - 1, rows - 1], // main diagonal, corner to corner
      [cols - 1, 0, 0, rows - 1], // anti-diagonal
      [0, midR, cols - 1, midR], // equatorial span
      [midC, 0, midC, rows - 1], // meridian span
      [0, qR, cols - 1, rows - 1 - qR], // shallow diagonal
    ],
  });
}

interface GridSpec {
  readonly cols: number;
  readonly rows: number;
  readonly lonMin: number;
  readonly lonMax: number;
  readonly latMin: number;
  readonly latMax: number;
  /** Long great-circle geodesics as [c0, r0, c1, r1] index pairs. */
  readonly geodesics: readonly (readonly [number, number, number, number])[];
}

/**
 * Row-major square lattice: idx(c, r) = r*cols + c, vertices laid on an even
 * lon/lat grid. Edges are the grid mesh (right + down neighbours) plus the
 * given box-spanning geodesics. All edges are straight in topology space; the
 * globe projection is what bends them into great-circle arcs. Color is the
 * normalized distance from the box center.
 */
function buildGrid(spec: GridSpec): GeneratedTopology {
  const { cols, rows, lonMin, lonMax, latMin, latMax, geodesics } = spec;
  const vertexCount = cols * rows;
  const idx = (c: number, r: number): number => r * cols + c;
  const lonAt = (c: number): number =>
    cols === 1 ? lonMin : lonMin + (lonMax - lonMin) * (c / (cols - 1));
  const latAt = (r: number): number =>
    rows === 1 ? latMin : latMin + (latMax - latMin) * (r / (rows - 1));

  const vertexCoords = new Float32Array(vertexCount * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = idx(c, r);
      vertexCoords[v * 2] = lonAt(c);
      vertexCoords[v * 2 + 1] = latAt(r);
    }
  }

  const meshEdges = rows * (cols - 1) + cols * (rows - 1);
  const edgeCount = meshEdges + geodesics.length;
  const edges = new Uint32Array(edgeCount * 2);
  let e = 0;
  // Right neighbours.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      edges[e * 2] = idx(c, r);
      edges[e * 2 + 1] = idx(c + 1, r);
      e++;
    }
  }
  // Down neighbours.
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c < cols; c++) {
      edges[e * 2] = idx(c, r);
      edges[e * 2 + 1] = idx(c, r + 1);
      e++;
    }
  }
  // Long geodesics.
  for (const [c0, r0, c1, r1] of geodesics) {
    edges[e * 2] = idx(c0, r0);
    edges[e * 2 + 1] = idx(c1, r1);
    e++;
  }

  // Straight edges: no polyline points, so polylineStart is all zeros.
  const polylineStart = new Uint32Array(edgeCount + 1);

  // Color: normalized distance from the box center.
  const lonC = (lonMin + lonMax) / 2;
  const latC = (latMin + latMax) / 2;
  const color = new Float32Array(vertexCount);
  let maxD = 1e-6;
  for (let v = 0; v < vertexCount; v++) {
    const dLon = vertexCoords[v * 2]! - lonC;
    const dLat = vertexCoords[v * 2 + 1]! - latC;
    const d = Math.hypot(dLon, dLat);
    color[v] = d;
    if (d > maxD) maxD = d;
  }
  for (let v = 0; v < vertexCount; v++) color[v] = color[v]! / maxD;

  const topology: Topology = { vertexCount, vertexCoords, edges, polylineStart };
  return { topology, vertexCount, edgeCount, color };
}
