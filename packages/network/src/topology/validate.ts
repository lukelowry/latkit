import type { Topology } from './types.js';

/**
 * Validate the CPU-side graph shape accepted by {@link Topology}.
 *
 * @throws Error when counts, coordinates, endpoints, or polyline offsets are invalid.
 */
export function validateTopology(topology: Topology): void {
  const vertexCount = topology.vertexCount;
  if (!Number.isInteger(vertexCount) || vertexCount < 0) {
    throw new Error('invalid vertex count');
  }

  const vertexCoords = topology.vertexCoords;
  if (vertexCoords !== undefined) {
    if (!isTypedArray(vertexCoords, 'Float32Array')) {
      throw new Error('vertex coordinates must be Float32Array');
    }
    if (vertexCoords.length !== 0 && vertexCoords.length !== vertexCount * 2) {
      throw new Error('invalid vertex coordinate length');
    }
    validateFinite(vertexCoords, 'vertex coordinates');
  }

  const edges = topology.edges;
  if (!isTypedArray(edges, 'Uint32Array')) throw new Error('edges must be Uint32Array');
  if (edges.length % 2 !== 0) throw new Error('invalid edge length');
  const edgeCount = edges.length / 2;
  for (const endpoint of edges) {
    if (endpoint >= vertexCount) throw new Error('edge endpoint out of range');
  }

  const polylinePoints = topology.polylinePoints;
  if (polylinePoints !== undefined && !isTypedArray(polylinePoints, 'Float32Array')) {
    throw new Error('polyline points must be Float32Array');
  }
  const polylineLength = polylinePoints?.length ?? 0;
  if (polylineLength % 2 !== 0) throw new Error('invalid polyline point length');
  if (polylinePoints) validateFinite(polylinePoints, 'polyline points');
  const polylinePointCount = polylineLength / 2;

  const polylineStart = topology.polylineStart;
  if (!isTypedArray(polylineStart, 'Uint32Array')) {
    throw new Error('polylineStart must be Uint32Array');
  }
  if (polylineStart.length !== edgeCount + 1) {
    throw new Error('invalid polylineStart length');
  }
  if (polylineStart[0] !== 0) throw new Error('polylineStart must begin at zero');
  if (polylineStart[edgeCount] !== polylinePointCount) {
    throw new Error('polylineStart terminal mismatch');
  }
  for (let i = 1; i < polylineStart.length; i++) {
    if (polylineStart[i]! < polylineStart[i - 1]!) {
      throw new Error('polylineStart must be monotonic');
    }
  }
}

/** Recognize typed arrays across realms without requiring constructor identity. */
function isTypedArray(value: unknown, name: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${name}]`;
}

/** Reject non-finite geometry before it reaches bounds and sphere calculations. */
function validateFinite(values: Float32Array, name: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`invalid ${name}`);
  }
}
