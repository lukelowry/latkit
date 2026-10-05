import {
  appendedPages,
  type Data,
  type FieldBinding,
  type Item,
  type RowSelection,
} from '@latkit/model';
import type { Channel, ColorChannel, Point } from '@latkit/gpu';
/**
 * A sampled field of one type's rows, drawn as a line per row over the coordinate. Each channel
 * takes one value for every row, a field, or a scale: `color: 'voltage'`, `widthPx: 2`.
 */
export interface Trace {
  readonly from: string;
  readonly rows?: RowSelection;
  /** The sampled field each row draws, against the values axis. */
  readonly y: string | FieldBinding;
  readonly interpolation?: 'linear' | 'step-before' | 'step-after';
  /** A field colors over its extent in the window; the plotted field, over the values axis. */
  readonly color?: ColorChannel;
  /** Line width in CSS pixels; a field spans 0.5 to 4. 1.25 by default. */
  readonly widthPx?: Channel;
  readonly visible?: Channel<boolean>;
  readonly shade?: Channel;
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
/** What the monitor draws. */
export interface MonitorData {
  readonly source: Data;
  readonly traces: Readonly<Record<string, Trace>>;
}
/** The drawn traces of a config. */
export function monitorData({ source, traces }: MonitorData): MonitorData {
  return { source, traces: traces ?? {} };
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
