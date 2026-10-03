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
import type { MonitorData, TraceData as Trace } from './data.js';
import { domain, finite, fail } from './config.js';
export interface Binding {
  readonly name: string;
  readonly trace: Trace;
  readonly source: Data;
  readonly field: string;
  readonly schema: Schema;
  readonly rows?: RowSelection;
  /** Rows the trace draws. */
  readonly count: number;
  readonly fields: Readonly<Record<string, FieldInput>>;
  readonly colorDomain: Domain | null;
}
export function validateData(data: MonitorData): void {
  if (!data.source?.schema || !data.source.tables) fail('Monitor requires materialized data');
  for (const [name, trace] of Object.entries(data.traces)) {
    if (!name || !trace.from || !trace.field) fail('Trace requires a name, type and sampled field');
    if (typeof trace.field !== 'string' && !('field' in trace.field))
      fail('Trace requires a sampled field binding');
    if (trace.baseColor) kit.validateRgba(trace.baseColor);
    if (trace.widthPx !== undefined) finite(trace.widthPx, 'trace width', 0.1, 64);
    if (
      trace.interpolation &&
      !['linear', 'step-before', 'step-after'].includes(trace.interpolation)
    )
      fail('Invalid interpolation');
    if (trace.color?.domain && Array.isArray(trace.color.domain))
      domain(trace.color.domain as Domain);
  }
}
export function binding(input: FieldInput, source: Data, from: string): FieldBinding | undefined {
  return typeof input === 'string'
    ? { source, from, field: input }
    : 'field' in input
      ? input
      : undefined;
}
/** The traces as the monitor reads them; sampled color domains fit `window`. */
export async function describeBindings(
  reads: ReadScope,
  data: MonitorData,
  window: Domain,
): Promise<Binding[]> {
  const schemas = new Map<Data, Schema>();
  const describe = (source: Data) => {
    let schema = schemas.get(source);
    if (!schema) {
      schema = source.schema;
      schemas.set(source, schema);
    }
    return schema;
  };
  const result: Binding[] = [];
  for (const [name, trace] of Object.entries(data.traces)) {
    const main = binding(trace.field, data.source, trace.from)!;
    if (main.from !== trace.from) fail('Trace and field must belong to the same type');
    const schema = describe(main.source),
      field = fields(schema, trace.from)[main.field];
    if (
      !field?.sampled ||
      !['float32', 'float64', 'int32', 'uint32'].includes(field.type as string)
    )
      fail('Trace field must be sampled numeric data');
    if (trace.rows && main.rows && JSON.stringify(trace.rows) !== JSON.stringify(main.rows))
      fail('Specify the trace row selection once');
    let colorValue = false;
    // A field name reads the request's source, so a trace named by field follows appends.
    const mapped: Record<string, FieldInput> = {
      value: typeof trace.field === 'string' ? trace.field : { ...main, rows: undefined },
    };
    for (const [alias, input] of [
      ['color', trace.color?.field],
      ['visible', trace.visible],
      ['shade', trace.shade],
    ] as const) {
      if (input == null) continue;
      mapped[alias] = input;
      const other = binding(input, data.source, trace.from);
      if (!other) continue;
      if (other.from !== trace.from) fail('Visual fields must use the trace type');
      const definition = fields(describe(other.source), other.from)[other.field];
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
      if (alias === 'color')
        colorValue = other.source === main.source && other.field === main.field && !other.rows;
    }
    let colorDomain: Domain | null = null;
    const specified = trace.color?.domain;
    if (specified && Array.isArray(specified)) colorDomain = specified as unknown as Domain;
    else if (trace.color) {
      const input = trace.color.field,
        other = binding(input, data.source, trace.from);
      const sampled = other
        ? !!fields(describe(other.source), other.from)[other.field]?.sampled
        : false;
      if (!colorValue || (specified && typeof specified === 'object'))
        colorDomain = await reads.extent({
          source: data.source,
          from: trace.from,
          rows: trace.rows ?? main.rows,
          field: input,
          window: sampled
            ? specified && typeof specified === 'object' && 'window' in specified
              ? specified.window
              : { kind: 'range', between: window }
            : undefined,
        });
    }
    const rows = trace.rows ?? main.rows,
      table = main.source.tables[trace.from];
    const count = !rows
      ? table
        ? rowCount(table.rows)
        : 0
      : rows.kind === 'ids'
        ? rows.ids.length
        : rows.kind === 'range'
          ? rows.count
          : rows.values.length;
    result.push({
      name,
      trace,
      source: main.source,
      field: main.field,
      schema,
      rows,
      count,
      fields: mapped,
      colorDomain,
    });
  }
  return result;
}
export function fields(schema: Schema, type: string) {
  const result = schema.types[type]?.fields;
  if (!result) throw failure('invalid-input', 'Unknown model type ' + type);
  return result;
}
