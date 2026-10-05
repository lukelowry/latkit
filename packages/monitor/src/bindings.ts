import { kit } from '@latkit/gpu';
import {
  failure,
  rowCount,
  type Data,
  type Schema,
  type Domain,
  type RowSelection,
  type FieldBinding,
  type FieldInput,
  type ReadScope,
} from '@latkit/model';
import type { MonitorData, Trace } from './data.js';
import { domain, finite, fail } from './config.js';

/** What a trace reads: its values, and its channels; colors and widths map over their extents. */
const TRACE = {
  y: 'raw',
  color: 'color',
  widthPx: [1, 4],
  visible: 'raw',
  shade: 'raw',
} as const satisfies Readonly<Record<string, kit.ChannelKind>>;
export type TraceChannel = keyof typeof TRACE;
/** A row selection with its ids resolved. */
export type Rows = Exclude<RowSelection, { readonly kind: 'ids' }>;
export interface Binding {
  readonly name: string;
  readonly trace: Trace;
  readonly source: Data;
  /** The field the trace plots. */
  readonly field: string;
  readonly schema: Schema;
  /** The rows the trace draws, ids resolved; every row without one. */
  readonly rows?: Rows;
  /** Rows the trace draws. */
  readonly count: number;
  /** What one read of the trace requests: its values as `y`, and each channel's field. */
  readonly fields: Readonly<Record<string, FieldInput>>;
  readonly bound: kit.BoundChannels<TraceChannel>;
  /** Each channel ready to read; a color of the plotted field maps over the values axis. */
  readonly channels: Readonly<Record<TraceChannel, kit.ResolvedChannel>>;
  /** Whether the color follows the values axis rather than a domain of its own. */
  readonly colorFollows: boolean;
}
export function validateData(data: MonitorData): void {
  if (!data.source?.schema || !data.source.tables) fail('Monitor requires materialized data');
  for (const [name, trace] of Object.entries(data.traces)) {
    if (!name || !trace.from || !trace.y) fail('Trace requires a name, type and sampled field');
    if (typeof trace.y !== 'string' && !('field' in trace.y))
      fail('Trace requires a sampled field binding');
    if (
      trace.interpolation &&
      !['linear', 'step-before', 'step-after'].includes(trace.interpolation)
    )
      fail('Invalid interpolation');
    const { channels } = kit.bindChannels(trace, TRACE),
      { scale } = channels.color;
    if (Array.isArray(scale?.domain)) domain(scale.domain as Domain);
    if (typeof channels.widthPx.constant === 'number')
      finite(channels.widthPx.constant, 'trace width', 0.1, 64);
  }
}
export function binding(input: FieldInput, source: Data, from: string): FieldBinding | undefined {
  return typeof input === 'string'
    ? { source, from, field: input }
    : 'field' in input
      ? input
      : undefined;
}
/** The traces as the monitor reads them; sampled domains fit `window`. */
export async function describeBindings(
  reads: ReadScope,
  data: MonitorData,
  window: Domain,
): Promise<Binding[]> {
  const result: Binding[] = [];
  for (const [name, trace] of Object.entries(data.traces)) {
    const main = binding(trace.y, data.source, trace.from)!;
    if (main.from !== trace.from) fail('Trace and field must belong to the same type');
    const schema = main.source.schema,
      field = fields(schema, trace.from)[main.field];
    if (
      !field?.sampled ||
      !['float32', 'float64', 'int32', 'uint32'].includes(field.type as string)
    )
      fail('Trace field must be sampled numeric data');
    if (trace.rows && main.rows && JSON.stringify(trace.rows) !== JSON.stringify(main.rows))
      fail('Specify the trace row selection once');
    // A field name reads the request's source, so a trace named by field follows appends.
    const bound = kit.bindChannels(
      { ...trace, y: typeof trace.y === 'string' ? trace.y : { ...main, rows: undefined } },
      TRACE,
    );
    let colorFollows = false;
    for (const alias of ['color', 'widthPx', 'visible', 'shade'] as const) {
      const input = bound.channels[alias].field;
      if (input === undefined) continue;
      const other = binding(input, data.source, trace.from);
      if (!other) continue;
      if (other.from !== trace.from) fail('Visual fields must use the trace type');
      const definition = fields(other.source.schema, other.from)[other.field];
      if (!definition) fail('Unknown visual field ' + other.field);
      if (
        ![
          'float32',
          'float64',
          'int32',
          'uint32',
          ...(alias === 'visible' ? ['boolean'] : []),
        ].includes(definition.type as string)
      )
        fail('Visual fields must be scalar numeric data, or boolean visibility');
      // Colored by what it plots, a trace colors over the values axis unless given a domain.
      if (alias === 'color')
        colorFollows =
          other.source === main.source &&
          other.field === main.field &&
          !other.rows &&
          (bound.channels.color.scale?.domain ?? 'auto') === 'auto';
    }
    const selected = trace.rows ?? main.rows,
      table = main.source.tables[trace.from];
    // Ids resolve once here, so fitting, picking, and reading all test the same rows.
    let rows: Rows | undefined;
    if (selected?.kind === 'ids') {
      const read = await kit.readRows(reads, main.source, trace.from, selected),
        index = read.index ?? table?.index;
      rows = index
        ? { kind: 'indices', index, values: read.rows }
        : { kind: 'range', offset: 0, count: 0 };
    } else rows = selected;
    const own = colorFollows
      ? {
          ...bound,
          channels: { ...bound.channels, color: { ...bound.channels.color, scale: undefined } },
        }
      : bound;
    const channels = await kit.resolveChannels(
      reads,
      { source: data.source, from: trace.from, rows, window: { kind: 'range', between: window } },
      own,
      // The style's trace width stands in for a width each draw reads.
      { y: NaN, visible: 1 },
    );
    const count = rows ? rowCount(rows) : table ? rowCount(table.rows) : 0;
    result.push({
      name,
      trace,
      source: main.source,
      field: main.field,
      schema,
      rows,
      count,
      fields: bound.fields,
      bound,
      channels,
      colorFollows,
    });
  }
  return result;
}
export function fields(schema: Schema, type: string) {
  const result = schema.types[type]?.fields;
  if (!result) throw failure('invalid-input', 'Unknown model type ' + type);
  return result;
}
