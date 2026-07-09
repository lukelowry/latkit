/** CPU-side graph and geometry used to build network render buffers. */
export interface Topology {
  /** Number of logical graph vertices. */
  readonly vertexCount: number;
  /** Optional x/y or lon/lat coordinates, two f32 values per vertex. */
  readonly vertexCoords?: Float32Array;
  /** Edge endpoint vertex indices stored as `[from0, to0, from1, to1, ...]`. */
  readonly edges: Uint32Array;
  /**
   * Edge-to-polyline offset table with `edgeCount + 1` entries.
   *
   * The first entry must be `0`, entries must be monotonic, and the terminal
   * entry must equal the number of points in `polylinePoints`.
   */
  readonly polylineStart: Uint32Array;
  /** Optional intermediate x/y or lon/lat points, two f32 values per point. */
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
