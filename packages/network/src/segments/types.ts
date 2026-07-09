/** Opaque bytes containing the canonical encoded segment wire layout. */
export type EncodedSegments = Uint8Array<ArrayBuffer>;

/** Counts and fingerprint decoded from an encoded segment buffer. */
export interface EncodedSegmentsInfo {
  /** Number of topology vertices referenced by segment records. */
  readonly vertexCount: number;
  /** Number of topology edges represented in the edge-start table. */
  readonly edgeCount: number;
  /** Number of renderable edge segments in the records section. */
  readonly segmentCount: number;
  /** Hash of the topology inputs used to build the segment buffer. */
  readonly fingerprint: number;
}
