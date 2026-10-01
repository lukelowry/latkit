import type { Index, RowAxis, Version } from '@latkit/model';

export type GpuField = GpuValueField | GpuListField | GpuEnvelopeField;
/** Four lanes per bucket: first, minimum, maximum, last. Addresses use row and bucket. */
export interface GpuEnvelopeField {
  readonly kind: 'envelope';
  readonly values: GpuValueField;
  readonly coordinates: GpuValueField;
  readonly frames: GpuValueField;
  readonly continuous: GpuValueField;
}
export interface GpuListField {
  readonly kind: 'list';
  readonly slot: number;
  readonly items: GpuValueField;
}
export interface GpuValueField {
  readonly kind: 'value';
  readonly slot: number;
  readonly type: 'float32' | 'int32' | 'uint32' | 'boolean';
  readonly components: number;
  /** Add this Float64 origin to the stored relative value. Never reconstruct large origins in Float32. */
  readonly origin?: Float64Array;
}

/** One shader layout for queried fields, native rows/samples, and application values. Frame-scoped. */
export interface GpuPage {
  /** Native tile resolved before upload. */
  readonly native?: import('./binding.js').NativeFields;
  readonly version?: Version;
  readonly index: Index;
  readonly rows: RowAxis;
  /** Position in the rows supplied to fields, upload, or values; not physical identity. */
  readonly rowOffset: number;
  readonly columns: Readonly<Record<string, GpuField>>;
  readonly bindGroup: GPUBindGroup;
  readonly envelope?: { readonly firstBucket: number; readonly count: number };
  readonly samples?: {
    readonly firstFrame: number;
    readonly count: number;
    readonly coordinates: GpuValueField;
  };
}

export interface UploadOptions {
  readonly select: readonly string[];
  readonly float64?: 'relative' | 'float32';
  readonly maxPageBytes?: number;
}
