/** Little-endian `"NSEG"` magic word. */
export const MAGIC = 0x4745534e;

/** Number of u32/f32 words reserved for the segment header. */
export const HEADER_WORDS = 16;

/** Number of words in one segment record. */
export const SEGMENT_RECORD_WORDS = 8;

/** Number of f32 words in one pair of unit-sphere segment endpoints. */
export const SEGMENT_SPHERE_ENDPOINT_WORDS = 6;

/**
 * Header word indices for encoded segment buffers.
 *
 * @remarks
 * Segment storage is derived from topology for GPU edge rendering. It keeps
 * edge-major segment order so each edge maps to one contiguous instance range.
 *
 * Header, 16 words / 64 bytes:
 *
 * - words 0..3: magic, header word count, storage byte count, flags.
 * - words 4..7: vertex count, edge count, segment count, fingerprint.
 * - words 8..10: edge-start, record, and sphere-endpoint section offsets.
 *
 * Sections:
 *
 * - `u32 edgeStarts[edgeCount + 1]`
 * - `SegmentRecord records[segmentCount]`
 * - `f32 sphereEndpoints[segmentCount * 6]`
 *
 * SegmentRecord, 8 words / 32 bytes:
 *
 * - u32 edge id, from vertex id, to vertex id.
 * - u32 packed height range `tA/tB` as unorm16x2.
 * - f32 ax, ay, bx, by endpoint coordinates.
 */
export const W = {
  /** Magic number word. */
  magic: 0,
  /** Header size in words. */
  headerWords: 1,
  /** Total storage size in bytes. */
  storageBytes: 2,
  /** Layout flags; currently zero. */
  flags: 3,

  /** Topology vertex count. */
  vertexCount: 4,
  /** Topology edge count. */
  edgeCount: 5,
  /** Render segment count. */
  segmentCount: 6,
  /** Fingerprint of the source topology arrays. */
  fingerprint: 7,

  /** Word offset of the edge-to-segment range table. */
  edgeStarts: 8,
  /** Word offset of packed segment records. */
  records: 9,
  /** Word offset of unit-sphere segment endpoint triples. */
  sphereEndpoints: 10,
} as const;

/**
 * WGSL constants generated from segment header indices.
 *
 * @remarks
 * Section constants are header word indices. Shaders read `segments[CONST]` to
 * get the section word offset.
 */
export const WGSL_LAYOUT = `
const SEG_VERTEX_COUNT: u32 = ${W.vertexCount}u;
const SEG_EDGE_COUNT: u32 = ${W.edgeCount}u;
const SEG_COUNT: u32 = ${W.segmentCount}u;
const SEG_EDGE_STARTS: u32 = ${W.edgeStarts}u;
const SEG_RECORDS: u32 = ${W.records}u;
const SEG_SPHERE_ENDPOINTS: u32 = ${W.sphereEndpoints}u;
const SEGMENT_RECORD_WORDS: u32 = ${SEGMENT_RECORD_WORDS}u;
const SEGMENT_SPHERE_ENDPOINT_WORDS: u32 = ${SEGMENT_SPHERE_ENDPOINT_WORDS}u;
`;
