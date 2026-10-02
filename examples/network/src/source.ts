import {
  createData,
  textColumn,
  type Column,
  type Data,
  type DataType,
  type Index,
  type NumericArray,
  type NumericColumn,
  type ReferenceColumn,
  type Schema,
} from '@latkit/model';
export interface Table {
  readonly count: number;
  readonly columns: Readonly<Record<string, Column>>;
}
export function numeric(values: NumericArray): NumericColumn {
  return { kind: 'numeric', offset: 0, length: values.length, values };
}
/** Rows of `type`; the source serving it numbers them under its own Index. */
export function references(type: string, rows: Uint32Array): ReferenceColumn {
  return {
    kind: 'reference',
    index: { source: '', type, version: '1' },
    offset: 0,
    length: rows.length,
    values: rows,
  };
}
export function vector(values: Float32Array | Float64Array): Column {
  return { kind: 'vector', offset: 0, length: values.length / 2, size: 2, values: numeric(values) };
}
function type(column: Column): DataType {
  if (column.kind === 'vector')
    return {
      kind: 'vector',
      size: column.size,
      items: type(column.values) as 'float32' | 'float64',
    };
  if (column.kind === 'list') return { kind: 'list', items: type(column.values) };
  if (column.kind === 'reference') return { kind: 'reference', to: column.index.type };
  if (column.kind !== 'numeric') return column.kind;
  return column.values instanceof Float64Array
    ? 'float64'
    : column.values instanceof Float32Array
      ? 'float32'
      : column.values instanceof Int32Array
        ? 'int32'
        : 'uint32';
}
function identify(column: Column, source: string): Column {
  if (column.kind === 'reference') return { ...column, index: { ...column.index, source } };
  if (column.kind === 'list') return { ...column, values: identify(column.values, source) };
  return column;
}
/** The example owns these immutable values; views receive data directly. */
export class ExampleSource {
  readonly version = '1';
  readonly schema: Schema;
  readonly data: Data;
  readonly bytes: number;
  constructor(
    readonly tables: Readonly<Record<string, Table>>,
    readonly source = crypto.randomUUID(),
  ) {
    const types: Record<string, Schema['types'][string]> = {};
    const buffers = new Set<ArrayBufferLike>();
    const visit = (value: unknown): void => {
      if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(tables);
    this.bytes = [...buffers].reduce((sum, b) => sum + b.byteLength, 0);
    for (const [name, table] of Object.entries(tables)) {
      const fields = Object.fromEntries(
        Object.entries(table.columns).map(([name, column]) => [name, { type: type(column) }]),
      );
      // Every example places its rows by longitude and latitude.
      const spatial = table.columns.position ? 'position' : table.columns.points ? 'points' : null;
      types[name] = {
        fields,
        ...(spatial ? { spatial: { field: spatial, system: 'geographic' as const } } : {}),
      };
    }
    this.schema = {
      types,
    };
    this.data = createData(
      this.schema,
      this.version,
      Object.entries(tables).map(([name, table]) => ({
        kind: 'rows' as const,
        index: this.index(name),
        rows: { kind: 'range' as const, offset: 0, count: table.count },
        ids: textColumn(Array.from({ length: table.count }, (_, i) => name + ':' + i)),
        columns: Object.fromEntries(
          Object.entries(table.columns).map(([field, column]) => [
            field,
            identify(column, this.source),
          ]),
        ),
      })),
    );
  }
  index(type: string): Index {
    return { source: this.source, type, version: '1' };
  }
}
