import type { Queryable, RowSelection, SampleRange, Version } from '@latkit/model';
import type { kit, RGBA } from '@latkit/gpu';
/** A sampled field of one type's rows, drawn as a line per row. */
export interface Trace {
  readonly from: string;
  readonly rows?: RowSelection;
  readonly field: string | kit.FieldBinding;
  readonly interpolation?: 'linear' | 'step-before' | 'step-after';
  /** A field name colors by that field with defaults. */
  readonly color?: string | kit.ColorScale | null;
  readonly baseColor?: RGBA;
  readonly widthPx?: number;
  readonly visible?: kit.FieldInput | null;
  readonly shade?: kit.FieldInput | null;
}
/** Exact native observation; envelopes are never reported as exact readings. */
export interface Reading extends kit.DataHit {
  readonly version: Version;
  readonly trace: string;
  readonly field: string;
  readonly frame: number;
  readonly coordinate: number;
  readonly value: number;
  readonly point: readonly [x: number, y: number];
}

export type TraceData = Omit<Trace, 'color'> & { readonly color?: kit.ColorScale | null };
/** What the monitor draws: traces over the window their color domains are read in. */
export interface MonitorData {
  readonly source: Queryable;
  readonly window: SampleRange;
  readonly traces: Readonly<Record<string, TraceData>>;
}
const expanded = new WeakMap<Trace, TraceData>();
/** Expand shorthands, keeping each unchanged trace's identity. */
export function monitorData(
  config: { readonly source: Queryable; readonly traces: Readonly<Record<string, Trace>> },
  window: SampleRange,
): MonitorData {
  const traces = Object.fromEntries(
    Object.entries(config.traces ?? {}).map(([name, trace]) => {
      let found = expanded.get(trace);
      if (!found) {
        found =
          typeof trace.color === 'string'
            ? Object.freeze({ ...trace, color: { field: trace.color } })
            : (trace as TraceData);
        expanded.set(trace, found);
      }
      return [name, found];
    }),
  );
  return { source: config.source, window, traces };
}
