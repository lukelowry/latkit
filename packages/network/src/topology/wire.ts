/** Little-endian `"NTOP"` magic word. */
export const MAGIC = 0x504f544e;

/** Number of u32/f32 words reserved for the topology header. */
export const HEADER_WORDS = 32;

/**
 * Header word indices for encoded topology buffers.
 *
 * @remarks
 * The buffer is a little-endian u32/f32 word array. Header offsets are word
 * offsets from the start of the buffer, and sections follow the header without
 * padding.
 *
 * Header, 32 words / 128 bytes:
 *
 * - words 0..3: magic, header word count, storage byte count, flags.
 * - words 4..5: vertex count and edge count.
 * - words 8..10: vertex coordinate offset, fingerprint, sphere offset.
 * - words 16..20: x/y bounds and characteristic length as f32 values.
 *
 * Sections:
 *
 * - `f32 vertexCoords[vertexCount * 2]`
 * - `f32 vertexSphere[vertexCount * 3]`
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

  /** Logical vertex count. */
  vCount: 4,
  /** Logical edge count. */
  eCount: 5,

  /** Word offset of the interleaved vertex coordinate section. */
  vCoords: 8,
  /** Fingerprint of the topology source arrays. */
  fingerprint: 9,
  /** Word offset of the vertex unit-sphere position section. */
  vSphere: 10,

  /** Minimum x bound stored as f32. */
  xMin: 16,
  /** Maximum x bound stored as f32. */
  xMax: 17,
  /** Minimum y bound stored as f32. */
  yMin: 18,
  /** Maximum y bound stored as f32. */
  yMax: 19,
  /** Typical coordinate-space spacing stored as f32. */
  characteristicLength: 20,
} as const;

/**
 * WGSL constants generated from topology header indices.
 *
 * @remarks
 * Section constants are header word indices. Shaders read `topology[CONST]` to
 * get the section word offset.
 */
export const WGSL_LAYOUT = `
const V_COUNT: u32 = ${W.vCount}u;
const E_COUNT: u32 = ${W.eCount}u;

const V_COORDS: u32 = ${W.vCoords}u;
const V_SPHERE: u32 = ${W.vSphere}u;
`;
