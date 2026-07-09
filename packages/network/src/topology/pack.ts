import type { Bounds, Topology } from './types.js';

/** Cached generated layouts for topologies that omit explicit vertex coordinates. */
const fallbackCoords = new WeakMap<Topology, Float32Array>();

/** Shared empty coordinate array for topologies with no polyline points. */
const EMPTY_F32 = new Float32Array(0);

/** Build the default unit-ring vertex layout used when geometry is absent. */
export function ringLayout(vertexCount: number): Float32Array {
  const out = new Float32Array(vertexCount * 2);
  if (vertexCount <= 1) return out;

  const step = (2 * Math.PI) / vertexCount;
  for (let i = 0; i < vertexCount; i++) {
    const theta = step * i;
    out[i * 2] = Math.cos(theta);
    out[i * 2 + 1] = Math.sin(theta);
  }
  return out;
}

/** Count render segments implied by each edge polyline plus its endpoint span. */
export function segmentCountFor(polylineStart: Uint32Array): number {
  let count = 0;
  for (let edge = 0; edge < polylineStart.length - 1; edge++) {
    count += polylineStart[edge + 1]! - polylineStart[edge]! + 1;
  }
  return count;
}

/** Return the edge count implied by the packed endpoint-pair array. */
export function edgeCountOf(topology: Topology): number {
  return topology.edges.length / 2;
}

/** Return topology polyline points, or a shared empty array when absent. */
export function polylinePointsOf(topology: Topology): Float32Array {
  return topology.polylinePoints ?? EMPTY_F32;
}

/** Return explicit vertex coordinates or a cached ring fallback for the topology. */
export function resolveVertexCoords(topology: Topology): Float32Array {
  const coords = topology.vertexCoords;
  if (coords && coords.length > 0) return coords;

  const expected = topology.vertexCount * 2;
  const cached = fallbackCoords.get(topology);
  if (cached && cached.length === expected) return cached;

  const next = ringLayout(topology.vertexCount);
  fallbackCoords.set(topology, next);
  return next;
}

/** Compute a deterministic u32 fingerprint for topology geometry inputs. */
export function topologyFingerprint(input: {
  readonly vertexCount: number;
  readonly vertexCoords: Float32Array;
  readonly edges: Uint32Array;
  readonly polylineStart: Uint32Array;
  readonly polylinePoints: Float32Array;
}): number {
  let hash = 0x811c9dc5;
  hash = mixU32(hash, input.vertexCount);
  hash = mixF32Array(hash, input.vertexCoords);
  hash = mixU32Array(hash, input.edges);
  hash = mixU32Array(hash, input.polylineStart);
  hash = mixF32Array(hash, input.polylinePoints);
  return hash;
}

/** Mix a typed u32 array into the running topology fingerprint. */
function mixU32Array(hash: number, values: Uint32Array): number {
  hash = mixU32(hash, values.length);
  for (const value of values) hash = mixU32(hash, value);
  return hash;
}

/** Mix the raw IEEE-754 words of a f32 array into the running fingerprint. */
function mixF32Array(hash: number, values: Float32Array): number {
  hash = mixU32(hash, values.length);
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length);
  for (const word of words) hash = mixU32(hash, word);
  return hash;
}

/** Apply one FNV-1a-style u32 mixing step. */
function mixU32(hash: number, value: number): number {
  hash ^= value >>> 0;
  return Math.imul(hash, 0x01000193) >>> 0;
}

/**
 * Compute axis-aligned bounds for an interleaved x/y coordinate array.
 *
 * @throws Error when the coordinate array has an odd length.
 */
export function computeBounds(coords: Float32Array): Bounds {
  if (coords.length === 0) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  if (coords.length % 2 !== 0) throw new Error('invalid vertex coordinate length');

  let xMin = coords[0]!,
    xMax = coords[0]!;
  let yMin = coords[1]!,
    yMax = coords[1]!;
  for (let i = 2; i < coords.length; i += 2) {
    const x = coords[i]!,
      y = coords[i + 1]!;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  return { xMin, xMax, yMin, yMax };
}

/** Estimate a typical vertex spacing from bounds area and vertex count. */
export function estimateCharacteristicLength(vertexCount: number, bounds: Bounds): number {
  if (vertexCount < 2) return 1;
  return Math.sqrt(
    Math.max(1e-6, (bounds.xMax - bounds.xMin) * (bounds.yMax - bounds.yMin)) / vertexCount,
  );
}
