import type { Data, RowSelection, SampleRange, Version } from '@latkit/model';
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
  readonly source: Data;
  readonly window: SampleRange;
  readonly traces: Readonly<Record<string, TraceData>>;
}
const expanded = new WeakMap<Trace, TraceData>();
/** Expand shorthands, keeping each unchanged trace's identity. */
export function monitorData(
  config: { readonly source: Data; readonly traces: Readonly<Record<string, Trace>> },
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

/** A proof of append-only change from shared page identity, independent of producer lifecycle. */
export function appended(before: Data, after: Data): { offset: number; count: number } | undefined {
  if (before.schema !== after.schema) return;
  if (Object.keys(before.tables).length !== Object.keys(after.tables).length) return;
  let result: { offset: number; count: number } | undefined;
  for (const [type, a] of Object.entries(before.tables)) {
    const b = after.tables[type];
    if (
      !b ||
      a.rows !== b.rows ||
      a.ids !== b.ids ||
      a.index.source !== b.index.source ||
      a.index.type !== b.index.type ||
      a.index.version !== b.index.version
    )
      return;
    for (const [field, definition] of Object.entries(before.schema.types[type].fields)) {
      const x = a.fields[field] ?? [],
        y = b.fields[field] ?? [];
      if (!definition.sampled) {
        if (x !== y) return;
        continue;
      }
      if (y.length <= x.length || x.some((page, i) => page !== y[i])) return;
      let first = Infinity,
        last = -Infinity,
        previous = -Infinity;
      for (const page of x)
        if (page.samples)
          previous = Math.max(previous, page.samples.firstFrame + page.samples.coordinates.length);
      for (let i = x.length; i < y.length; i++) {
        const sample = y[i].samples;
        if (!sample) return;
        first = Math.min(first, sample.firstFrame);
        last = Math.max(last, sample.firstFrame + sample.coordinates.length);
      }
      if (Number.isFinite(previous) && first !== previous) return;
      const range = { offset: first, count: last - first };
      if (result && (result.offset !== range.offset || result.count !== range.count)) return;
      result = range;
    }
  }
  return result;
}
