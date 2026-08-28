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

/** Validated metadata and reusable typed views over encoded segment storage. */
export interface DecodedSegments {
  /** Original encoded storage retained for GPU upload. */
  readonly encoded: EncodedSegments;
  /** Validated segment counts and topology fingerprint. */
  readonly info: EncodedSegmentsInfo;
  /** Unsigned view used for ids and packed record fields. */
  readonly u32: Uint32Array<ArrayBuffer>;
  /** Float view used for segment coordinates. */
  readonly f32: Float32Array<ArrayBuffer>;
  /** Owned edge-to-segment range table used by CPU consumers. */
  readonly edgeStarts: Uint32Array<ArrayBuffer>;
  /** Segment-record start offset, in 32-bit words. */
  readonly recordsOffset: number;
}
