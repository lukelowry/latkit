import type { Index, RowAxis, Version } from '@latkit/model';

export interface GpuField {
  readonly slot: number;
  readonly type: 'float32' | 'int32' | 'uint32' | 'boolean';
  readonly components: number;
  /** Add this Float64 origin to the stored relative value. Never reconstruct large origins in Float32. */
  readonly origin?: Float64Array;
}

/** One shader layout for queried fields, native rows/samples, and application values. Frame-scoped. */
export interface GpuPage {
  readonly version?: Version;
  readonly index: Index;
  readonly rows: RowAxis;
  /** Position in the rows supplied to fields, upload, or values; not physical identity. */
  readonly rowOffset: number;
  readonly columns: Readonly<Record<string, GpuField>>;
  readonly bindGroup: GPUBindGroup;
  readonly samples?: {
    readonly firstFrame: number;
    readonly count: number;
    readonly coordinates: GpuField;
  };
}

export interface UploadOptions {
  readonly select: readonly string[];
  readonly float64?: 'relative' | 'float32';
  readonly maxPageBytes?: number;
}
