import type { Index, RowAxis, Version } from '@latkit/model';

export interface GpuBitmap {
  readonly binding: GPUBufferBinding;
  readonly offset: number;
  readonly rowStride: number;
  readonly frameStride: number;
}

/** Address = offset + frame * frameStride + row * rowStride + component. Boolean addresses are bits; numeric addresses are scalar elements. */
export interface GpuColumn {
  readonly binding: GPUBufferBinding;
  readonly type: 'float32' | 'int32' | 'uint32' | 'boolean';
  readonly offset: number;
  readonly components: number;
  readonly rowStride: number;
  readonly frameStride: number;
  readonly validity?: GpuBitmap;
  /** Logical component = Float64 origin + stored value; absent means zero. */
  readonly origin?: Float64Array;
}

/** Device-local descriptors. Valid only for the frame that prepared them. */
export interface GpuPage {
  readonly version?: Version;
  readonly index: Index;
  readonly rows: RowAxis;
  /** Position in the input block, never a physical row number. */
  readonly rowOffset: number;
  readonly rowMap?: GPUBufferBinding;
  readonly columns: Readonly<Record<string, GpuColumn>>;
  readonly samples?: {
    readonly firstFrame: number;
    readonly count: number;
    readonly coordinates: GpuColumn;
  };
}

export interface UploadOptions {
  readonly select: readonly string[];
  /** Required for Float64 value columns; coordinates always use relative encoding. */
  readonly float64?: 'relative' | 'float32';
  /** Omitted uses the owner's page bound. Cannot increase it. */
  readonly maxPageBytes?: number;
}

/** Shared WGSL addressing. Values/bitmaps remain renderer-declared storage bindings. */
export const columnShader = /* wgsl */ `
struct ColumnAddress {
  offset: u32,
  rowStride: u32,
  frameStride: u32,
  components: u32,
}
fn columnIndex(address: ColumnAddress, row: u32, frame: u32, component: u32) -> u32 {
  return address.offset + row * address.rowStride + frame * address.frameStride + component;
}
fn validityBit(word: u32, bit: u32) -> bool {
  return (word & (1u << (bit & 31u))) != 0u;
}
`;
