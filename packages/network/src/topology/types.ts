/**
 * The graph shape a network loads is `@latkit/model`'s `Topology`, re-exported here so every
 * internal module names one type.
 *
 * @remarks
 * `vertexCoords` and `polylinePoints` are interleaved coordinate pairs. Flat and tilt projections
 * accept arbitrary `x, y` coordinates; the globe and other geographic features are available when
 * caller-supplied coordinates fit longitude and latitude bounds, unless `coordinateSpace` opts out.
 * `polylineStart` holds `edgeCount + 1` offsets into `polylinePoints`, beginning at `0`, monotonic,
 * and ending at the point count; straight edges use a zero-filled table.
 */
export type { Topology } from '@latkit/model';

/** Axis-aligned bounds for topology vertex coordinates. */
export interface Bounds {
  /** Minimum x coordinate. */
  readonly xMin: number;
  /** Maximum x coordinate. */
  readonly xMax: number;
  /** Minimum y coordinate. */
  readonly yMin: number;
  /** Maximum y coordinate. */
  readonly yMax: number;
}

/** Opaque bytes containing the canonical encoded topology wire layout. */
export type EncodedTopology = Uint8Array<ArrayBuffer>;

/** Header-derived metadata for an encoded topology buffer. */
export interface EncodedTopologyInfo {
  /** Number of logical graph vertices. */
  readonly vertexCount: number;
  /** Number of graph edges. */
  readonly edgeCount: number;
  /** Hash of the topology inputs used to build the buffer. */
  readonly fingerprint: number;
  /** Bounds of the vertex coordinate section. */
  readonly bounds: Bounds;
  /** Typical coordinate-space spacing used to scale visual defaults. */
  readonly characteristicLength: number;
}
