/**
 * CPU-side graph and geometry used to build network render buffers.
 *
 * @remarks
 * `vertexCoords` and `polylinePoints` are interleaved coordinate pairs. Flat
 * and tilt projections accept arbitrary `x, y` coordinates. Globe projection
 * and other geographic features are available when caller-supplied
 * coordinates fit geographic longitude and latitude bounds; see
 * {@link Topology.coordinateSpace} to override that inference.
 *
 * `polylineStart` is an offset table into `polylinePoints`. It must contain
 * `edgeCount + 1` entries, begin at `0`, stay monotonic, and end at the number
 * of polyline points. Straight edges with no bend points can use a zero-filled
 * table.
 *
 * @example
 * ```ts
 * const topology: Topology = {
 *   vertexCount: 3,
 *   vertexCoords: new Float32Array([-96, 30, -95, 31, -94, 30]),
 *   edges: new Uint32Array([0, 1, 1, 2]),
 *   polylineStart: new Uint32Array([0, 0, 0]),
 * };
 * ```
 */
export interface Topology {
  /** Number of logical graph vertices. */
  readonly vertexCount: number;
  /**
   * Optional `x, y` or `lon, lat` coordinates, two f32 values per vertex.
   *
   * @remarks
   * Omit this field to use a generated unit-ring layout.
   */
  readonly vertexCoords?: Float32Array;
  /**
   * Optional declaration of how coordinates are interpreted.
   *
   * @remarks
   * When omitted, caller-supplied coordinates whose bounds fit longitude and
   * latitude ranges are inferred geographic. Pass `'cartesian'` to keep
   * abstract `x, y` data off geographic features (daylight shading, ground
   * clipping, globe availability) even when it fits those bounds.
   * `'geographic'` documents intent; coordinates must still fit longitude and
   * latitude ranges to take effect. Generated ring layouts are never
   * geographic.
   */
  readonly coordinateSpace?: 'cartesian' | 'geographic';
  /**
   * Edge endpoint vertex indices stored as `[from0, to0, from1, to1, ...]`.
   *
   * @remarks
   * Every endpoint index must be less than `Topology.vertexCount`.
   */
  readonly edges: Uint32Array;
  /**
   * Edge-to-polyline offset table with `edgeCount + 1` entries.
   *
   * The first entry must be `0`, entries must be monotonic, and the terminal
   * entry must equal the number of points in `polylinePoints`.
   */
  readonly polylineStart: Uint32Array;
  /**
   * Optional intermediate `x, y` or `lon, lat` points, two f32 values per point.
   *
   * @remarks
   * These are bend points only. Edge endpoints still come from
   * `Topology.edges` and `Topology.vertexCoords`.
   */
  readonly polylinePoints?: Float32Array;
}

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
