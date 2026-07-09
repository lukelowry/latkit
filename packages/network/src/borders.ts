/** Number of bytes in one packed border vertex. */
export const BORDER_VERTEX_STRIDE_BYTES = 24;

/**
 * GPU-ready world border geometry consumed directly by the renderer.
 *
 * @remarks
 * `vertices` is interleaved in `BORDER_VERTEX_STRIDE_BYTES` chunks:
 * - bytes 0..7: longitude and latitude as f32 degrees.
 * - bytes 8..19: unit-sphere ECEF x/y/z as f32.
 * - bytes 20..23: render layer as u32. Layer `0` is coastline, `1` is a
 *   major administrative boundary, and `2` is a minor administrative
 *   boundary; other layers are accepted but render with the fallback tier.
 *
 * `indices` contains u32 line-strip indices. Independent polylines are
 * separated by the `0xffffffff` primitive-restart sentinel.
 */
export interface Borders {
  /** Interleaved vertex bytes in the border vertex layout. */
  readonly vertices: Uint8Array<ArrayBuffer>;
  /** U32 line-strip indices with primitive-restart separators. */
  readonly indices: Uint32Array<ArrayBuffer>;
}

/**
 * Validate structural invariants needed before border buffers reach the GPU.
 *
 * @throws Error when vertex stride or index alignment is invalid.
 */
export function validateBorders(borders: Borders): void {
  if (borders.vertices.byteLength % BORDER_VERTEX_STRIDE_BYTES !== 0) {
    throw new Error(
      `Invalid borders: vertex data must be a multiple of ${BORDER_VERTEX_STRIDE_BYTES} bytes`,
    );
  }
  if (borders.indices.byteOffset % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(
      `Invalid borders: index data must be ${Uint32Array.BYTES_PER_ELEMENT}-byte aligned`,
    );
  }
}
