import type { Topology } from '@latkit/network';

/**
 * A synthetic power-grid-like network. Vertices are scattered over a
 * continental-US longitude/latitude box (so the globe projection can host it),
 * wired into a connected mesh of nearest-neighbour "lines" plus a handful of
 * long polyline "transmission corridors" that bend around the terrain.
 *
 * Returns the Topology plus per-vertex signals to drive the color/size channels.
 */
export interface FakeNetwork {
  readonly topology: Topology;
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** Per-vertex scalar in [0, 1] for the vertexColor channel. */
  readonly load: Float32Array;
  /** Per-vertex scalar in [0, 1] for the vertexSize channel (hubs run large). */
  readonly degree: Float32Array;
}

// Continental-US-ish window, in degrees. Stays inside the globe's lon/lat bounds.
const LON_MIN = -124;
const LON_MAX = -68;
const LAT_MIN = 25;
const LAT_MAX = 49;

const COLS = 20;
const ROWS = 13;
const DROP_CHANCE = 0.12; // thin the grid so it does not read as perfectly regular
const NEAREST_LINES = 3; // local connections per vertex
const CORRIDORS = 7; // long bending transmission runs
const SEED = 0x51a7c0de;

interface Pt {
  x: number;
  y: number;
}

interface Edge {
  a: number;
  b: number;
  bends: Pt[]; // intermediate polyline points; empty for a straight line
}

export function makeFakeNetwork(): FakeNetwork {
  const random = createRandom(SEED);
  const pts = scatter(random);
  const edges = wire(pts, random);

  const topology = encode(pts, edges);
  const degree = degreeSignal(pts.length, edges);
  const load = loadSignal(pts, degree);

  return {
    topology,
    vertexCount: pts.length,
    edgeCount: edges.length,
    load,
    degree,
  };
}

/** Jittered grid sampling: one point per cell, randomly thinned. */
function scatter(random: () => number): Pt[] {
  const pts: Pt[] = [];
  const cw = (LON_MAX - LON_MIN) / COLS;
  const ch = (LAT_MAX - LAT_MIN) / ROWS;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (random() < DROP_CHANCE) continue;
      const x = LON_MIN + (c + 0.5 + (random() - 0.5) * 0.9) * cw;
      const y = LAT_MIN + (r + 0.5 + (random() - 0.5) * 0.9) * ch;
      pts.push({ x, y });
    }
  }
  return pts;
}

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Connect the scatter into a single connected component: nearest-neighbour
 * local lines, a Prim minimum spanning tree to guarantee connectivity, then a
 * few long corridors drawn as bent polylines.
 */
function wire(pts: Pt[], random: () => number): Edge[] {
  const n = pts.length;
  const key = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const seen = new Set<string>();
  const edges: Edge[] = [];

  const add = (a: number, b: number, bends: Pt[] = []): void => {
    if (a === b) return;
    const k = key(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ a, b, bends });
  };

  // Nearest-neighbour local lines.
  for (let i = 0; i < n; i++) {
    const near = [...Array(n).keys()]
      .filter((j) => j !== i)
      .sort((p, q) => dist2(pts[i]!, pts[p]!) - dist2(pts[i]!, pts[q]!))
      .slice(0, NEAREST_LINES);
    for (const j of near) add(i, j);
  }

  // Prim MST over the complete graph so the whole network is one component.
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(-1);
  best[0] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!inTree[v] && (u < 0 || best[v]! < best[u]!)) u = v;
    if (u < 0) break;
    inTree[u] = true;
    if (from[u]! >= 0) add(u, from[u]!);
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = dist2(pts[u]!, pts[v]!);
      if (d < best[v]!) {
        best[v] = d;
        from[v] = u;
      }
    }
  }

  // Long transmission corridors with a perpendicular bend, exercising polylines.
  for (let i = 0; i < CORRIDORS; i++) {
    const a = Math.floor(random() * n);
    const b = Math.floor(random() * n);
    if (a === b) continue;
    const pa = pts[a]!;
    const pb = pts[b]!;
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;
    // Offset the midpoint perpendicular to the run for a visible arc.
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = (random() - 0.5) * 6;
    const bend: Pt = { x: mx + (-dy / len) * off, y: my + (dx / len) * off };
    add(a, b, [bend]);
  }

  return edges;
}

/** Pack points + edges into the network wire-format Topology. */
function encode(pts: Pt[], edges: Edge[]): Topology {
  const vertexCoords = new Float32Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    vertexCoords[i * 2] = pts[i]!.x;
    vertexCoords[i * 2 + 1] = pts[i]!.y;
  }

  const edgeIndices = new Uint32Array(edges.length * 2);
  const polylineStart = new Uint32Array(edges.length + 1);
  const bendPts: number[] = [];
  let cursor = 0;
  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e]!;
    edgeIndices[e * 2] = edge.a;
    edgeIndices[e * 2 + 1] = edge.b;
    polylineStart[e] = cursor;
    for (const p of edge.bends) {
      bendPts.push(p.x, p.y);
      cursor += 1;
    }
  }
  polylineStart[edges.length] = cursor;

  return {
    vertexCount: pts.length,
    vertexCoords,
    edges: edgeIndices,
    polylineStart,
    polylinePoints: cursor > 0 ? new Float32Array(bendPts) : undefined,
  };
}

/** Normalised vertex degree in [0, 1]. */
function degreeSignal(n: number, edges: Edge[]): Float32Array {
  const raw = new Float32Array(n);
  for (const e of edges) {
    raw[e.a] = raw[e.a]! + 1;
    raw[e.b] = raw[e.b]! + 1;
  }
  let max = 1;
  for (const d of raw) if (d > max) max = d;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i]! / max;
  return out;
}

/**
 * A smooth spatial field blended with local connectivity, standing in for a
 * "loading" scalar you might color a grid by.
 */
function loadSignal(pts: Pt[], degree: Float32Array): Float32Array {
  const out = new Float32Array(pts.length);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const u = (p.x - LON_MIN) / (LON_MAX - LON_MIN);
    const v = (p.y - LAT_MIN) / (LAT_MAX - LAT_MIN);
    const field = Math.sin(u * Math.PI * 1.7) * Math.cos(v * Math.PI * 2.1);
    const value = 0.55 * (field * 0.5 + 0.5) + 0.45 * degree[i]!;
    out[i] = value;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i]! - lo) / span;
  return out;
}
