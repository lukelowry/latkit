import {
  appendedPages,
  type Data,
  type FieldBinding,
  type FieldInput,
  type Item,
  type RowSelection,
} from '@latkit/model';
import type { kit, Point, RGBA, ColorScale } from '@latkit/gpu';
/** A sampled field of one type's rows, drawn as a line per row. */
export interface Trace {
  readonly from: string;
  readonly rows?: RowSelection;
  readonly field: string | FieldBinding;
  readonly interpolation?: 'linear' | 'step-before' | 'step-after';
  /** A field name colors by that field with defaults. */
  readonly color?: string | ColorScale | null;
  readonly baseColor?: RGBA;
  readonly widthPx?: number;
  readonly visible?: FieldInput | null;
  readonly shade?: FieldInput | null;
}
/** A row a monitor draws: selected in every trace of its type, or in one when it names `trace`. */
export interface MonitorItem extends Item {
  readonly trace?: string;
}
/** An exact observation. */
export interface Reading extends MonitorItem {
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
/** What the monitor draws. */
export interface MonitorData {
  readonly source: Data;
  readonly traces: Readonly<Record<string, TraceData>>;
}
/** The drawn traces of a config whose field shorthands the view already expanded. */
export function monitorData(config: {
  readonly source: Data;
  readonly traces: Readonly<Record<string, Trace>>;
}): MonitorData {
  return {
    source: config.source,
    traces: (config.traces ?? {}) as Readonly<Record<string, TraceData>>,
  };
}
/** Whether `after` only appends observations to `before`: every drawn frame stands. */
export function continues(before: Data, after: Data): boolean {
  if (
    before.schema !== after.schema ||
    Object.keys(before.tables).length !== Object.keys(after.tables).length
  )
    return false;
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
      return false;
    for (const [field, definition] of Object.entries(before.schema.types[type].fields)) {
      const x = a.fields[field],
        y = b.fields[field];
      if (x === y) continue;
      if (!definition.sampled || !x || !y || !appendedPages(x, y)) return false;
    }
  }
  return true;
}
