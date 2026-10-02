import { appendedPages } from '@latkit/model';
import type { Data, FieldBinding, FieldInput, RowSelection, SampleRange } from '@latkit/model';
import type { DataHit, kit, Point, RGBA } from '@latkit/gpu';
/** A sampled field of one type's rows, drawn as a line per row. */
export interface Trace {
  readonly from: string;
  readonly rows?: RowSelection;
  readonly field: string | FieldBinding;
  readonly interpolation?: 'linear' | 'step-before' | 'step-after';
  /** A field name colors by that field with defaults. */
  readonly color?: string | kit.ColorScale | null;
  readonly baseColor?: RGBA;
  readonly widthPx?: number;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
}
/** Exact native observation; envelopes are never reported as exact readings. */
export interface Reading extends DataHit {
  readonly trace: string;
  readonly field: string;
  readonly frame: number;
  readonly coordinate: number;
  readonly value: number;
  readonly point: Point;
}
/** Trace options whose string value names a field. */
export const FIELD_OPTIONS = ['color'] as const;
export type TraceData = kit.Expanded<Trace, (typeof FIELD_OPTIONS)[number]>;
/** What the monitor draws: traces over the window their color domains are read in. */
export interface MonitorData {
  readonly source: Data;
  readonly window: SampleRange;
  readonly traces: Readonly<Record<string, TraceData>>;
}
/** The drawn traces of a config whose field shorthands the view already expanded. */
export function monitorData(
  config: { readonly source: Data; readonly traces: Readonly<Record<string, Trace>> },
  window: SampleRange,
): MonitorData {
  return {
    source: config.source,
    window,
    traces: (config.traces ?? {}) as Readonly<Record<string, TraceData>>,
  };
}

export interface FrameRange {
  readonly offset: number;
  readonly count: number;
}
export type FrameRanges = ReadonlyMap<string, readonly FrameRange[]>;
/** Merge only overlapping/adjacent observations; gaps remain explicit. */
export function mergeRanges(ranges: readonly FrameRange[]): FrameRange[] {
  const result: { offset: number; count: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.offset - b.offset)) {
    const last = result.at(-1);
    if (last && range.offset <= last.offset + last.count)
      last.count = Math.max(last.offset + last.count, range.offset + range.count) - last.offset;
    else result.push({ ...range });
  }
  return result;
}
/** Independent column appends: unchanged sampled columns need not advance together. */
export function appended(before: Data, after: Data): FrameRanges | undefined {
  if (
    before.schema !== after.schema ||
    Object.keys(before.tables).length !== Object.keys(after.tables).length
  )
    return;
  const result = new Map<string, FrameRange[]>();
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
      const x = a.fields[field],
        y = b.fields[field];
      if (x === y) continue;
      if (!definition.sampled || !x || !y) return;
      const added = appendedPages(x, y);
      if (!added) return;
      const ranges: FrameRange[] = [];
      for (const page of added) {
        const sample = page.samples;
        if (!sample) return;
        ranges.push({ offset: sample.firstFrame, count: sample.coordinates.length });
      }
      if (ranges.length) result.set(type + ':' + field, mergeRanges(ranges));
    }
  }
  return result;
}
