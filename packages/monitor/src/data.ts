import { appendedPages, type Data } from '@latkit/model';
import type { Monitor } from './monitor.js';
/** What the monitor draws. */
export interface MonitorData {
  readonly source: Data;
  readonly traces: Readonly<Record<string, Monitor.TraceOptions>>;
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
