import type { Queryable, RowSelection, SampleRange, Version } from '@latkit/model';
import type { ColorScale, DataHit, FieldBinding, FieldInput, RGBA } from '@latkit/gpu';
export interface Trace {
  readonly from: string;
  readonly rows?: RowSelection;
  readonly field: string | FieldBinding;
  readonly interpolation?: 'linear' | 'step-before' | 'step-after';
  readonly color?: ColorScale | null;
  readonly baseColor?: RGBA;
  readonly widthPx?: number;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
}
export interface MonitorData {
  /** Borrowed native sampled acquisition, including remote Queryable sources. */
  readonly source: Queryable;
  /** Initial displayed coordinate interval; navigation changes the displayed window. */
  readonly window: SampleRange;
  /** Application trace names allow multiple fields of the same model type. */
  readonly traces: Readonly<Record<string, Trace>>;
}
/** Exact native observation; envelopes are never reported as exact readings. */
export interface Reading extends DataHit {
  readonly version: Version;
  readonly trace: string;
  readonly field: string;
  readonly frame: number;
  readonly coordinate: number;
  readonly value: number;
  readonly point: readonly [x: number, y: number];
}
