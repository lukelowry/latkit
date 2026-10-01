import {
  blockByteLength,
  validateQuery,
  type Column,
  type DataType,
  type Index,
  type NumericArray,
  type NumericColumn,
  type Query,
  type ReferenceColumn,
  type Queryable,
  type QueryOptions,
  type QueryHeader,
  type QueryBlock,
  type RequestOptions,
  type RetainOptions,
  type RowAxis,
  type Schema,
  type Update,
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
function failure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
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
/** Trim exposed views while preserving immutable native backing. Lists only rebase their offsets. */
function slice(column: Column, first: number, count: number): Column {
  const at = column.offset + first;
  if (column.validity) failure('unsupported', 'Example columns are non-nullable');
  if (column.kind === 'numeric') return numeric(column.values.subarray(at, at + count));
  if (column.kind === 'reference')
    return { ...column, offset: 0, length: count, values: column.values.subarray(at, at + count) };
  if (column.kind === 'vector')
    return {
      ...column,
      offset: 0,
      length: count,
      values: slice(column.values, at * column.size, count * column.size) as NumericColumn,
    };
  if (column.kind === 'list') {
    const begin = column.offsets[at]!,
      end = column.offsets[at + count]!;
    return {
      ...column,
      offset: 0,
      length: count,
      offsets: Int32Array.from(column.offsets.subarray(at, at + count + 1), (n) => n - begin),
      values: slice(column.values, begin, end - begin),
    };
  }
  return failure('unsupported', 'This example stores numeric, reference, vector, and list columns');
}
function text(values: readonly string[]): Column {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const offsets = new Int32Array(values.length + 1);
  for (let i = 0; i < values.length; i++) offsets[i + 1] = offsets[i]! + encoded[i]!.length;
  const bytes = new Uint8Array(offsets[values.length]!);
  encoded.forEach((value, i) => bytes.set(value, offsets[i]!));
  return { kind: 'text', offset: 0, length: values.length, offsets, bytes };
}
function owned<T>(value: T, seen = new Map<object, unknown>()): T {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (ArrayBuffer.isView(value)) {
    const result = (value as unknown as Uint8Array).slice();
    seen.set(value, result);
    return result as T;
  }
  const result = Array.isArray(value)
    ? (value as unknown[]).map((v) => owned(v, seen))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, owned(v, seen)]));
  seen.set(value, result);
  return result as T;
}

/** Immutable example data implements the native read contract; it is not a renderer adapter. */
export class ExampleSource implements Queryable {
  readonly version = '1';
  readonly schema: Schema;
  private closed = false;
  private readonly listeners = new Set<(update: Update) => void>();
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
      queries: ['rows'],
      limits: { maxBlockBytes: 1024 * 1024 },
      types,
    };
  }
  index(type: string): Index {
    return { source: this.source, type, version: '1' };
  }
  private check(options?: RequestOptions): void {
    options?.signal?.throwIfAborted();
    if (this.closed) failure('closed', 'Example acquisition is closed');
  }
  describe(options?: RequestOptions): Promise<Schema> {
    return Promise.resolve().then(() => {
      this.check(options);
      return this.schema;
    });
  }
  retain(options?: RetainOptions): Promise<Queryable> {
    return Promise.resolve().then(() => {
      this.check(options);
      if (options?.window) failure('invalid-input', 'This source contains static inputs');
      const maxBytes = options?.maxBytes ?? 128 * 1024 ** 2;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        failure('invalid-input', 'Invalid retain budget');
      if (this.bytes > maxBytes) failure('resource-limit', 'Retain budget exceeded');
      return new ExampleSource(this.tables, this.source);
    });
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const listener of this.listeners) listener({ kind: 'closed' });
    this.listeners.clear();
    return Promise.resolve();
  }
  on(_event: 'change', listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  query: Queryable['query'] = ((query: Query, options?: QueryOptions) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options?: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    const schema = await this.describe(options);
    const issues = validateQuery(schema, query);
    if (issues.length) failure(issues[0]!.code, issues[0]!.message);
    if (query.kind !== 'rows') failure('unsupported', 'Unsupported query');
    const table = this.tables[query.from]!,
      index = this.index(query.from);
    const selection = query.rows;
    let rows: RowAxis;
    if (selection?.kind === 'ids') {
      rows = {
        kind: 'indices',
        values: Uint32Array.from(selection.ids, (id) => {
          const prefix = query.from + ':';
          const row = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN;
          if (!Number.isSafeInteger(row) || row < 0 || row >= table.count || id !== prefix + row)
            failure('invalid-input', 'Unknown row ID');
          return row;
        }),
      };
    } else {
      if (
        selection?.index &&
        (selection.index.source !== index.source ||
          selection.index.type !== index.type ||
          selection.index.version !== index.version)
      )
        failure('conflict', 'Row identity does not match');
      rows =
        selection?.kind === 'indices'
          ? { kind: 'indices', values: selection.values }
          : {
              kind: 'range',
              offset: selection?.offset ?? 0,
              count: selection?.count ?? table.count,
            };
    }
    const count = (axis: RowAxis) => (axis.kind === 'range' ? axis.count : axis.values.length);
    const rowAt = (axis: RowAxis, i: number) =>
      axis.kind === 'range' ? axis.offset + i : axis.values[i]!;
    if (
      rows.kind === 'range'
        ? rows.offset + rows.count > table.count
        : rows.values.some((row) => row >= table.count)
    )
      failure('invalid-input', 'Unknown physical row');
    const value = (field: string, row: number): number => {
      const column = table.columns[field]!;
      if (column.kind !== 'numeric') return failure('invalid-input', 'Expected scalar field');
      return column.values[column.offset + row]!;
    };
    if (query.where?.length || query.orderBy?.length) {
      const selected = Array.from({ length: count(rows) }, (_, i) => rowAt(rows, i)).filter((row) =>
        (query.where ?? []).every((filter) => {
          const v = value(filter.field, row);
          switch (filter.operator) {
            case 'equal':
              return v === filter.value;
            case 'notEqual':
              return v !== filter.value;
            case 'lessThan':
              return v < filter.value;
            case 'lessThanOrEqual':
              return v <= filter.value;
            case 'greaterThan':
              return v > filter.value;
            case 'greaterThanOrEqual':
              return v >= filter.value;
            default:
              return false;
          }
        }),
      );
      if (query.orderBy?.length)
        selected.sort((a, b) => {
          for (const order of query.orderBy!) {
            const d = value(order.field, a) - value(order.field, b);
            if (d) return order.direction === 'ascending' ? d : -d;
          }
          return a - b;
        });
      rows = { kind: 'indices', values: Uint32Array.from(selected) };
    }
    const total = count(rows);
    const skip = Math.min(query.offset ?? 0, total);
    const length = Math.min(total - skip, query.limit ?? total);
    const bound = Math.min(options?.maxBlockBytes ?? Infinity, this.schema.limits.maxBlockBytes);
    if (!Number.isSafeInteger(bound) || bound < 1) failure('invalid-input', 'Invalid block bound');
    yield { kind: 'schema', version: this.version, schema: this.schema };
    let position = 0;
    do {
      this.check(options);
      if (!length && !query.count) break;
      const first = length ? rowAt(rows, skip + position) : 0;
      let n = Math.min(1024, length - position);
      if (rows.kind === 'indices')
        for (let i = 1; i < n; i++)
          if (rowAt(rows, skip + position + i) !== first + i) {
            n = i;
            break;
          }
      let block: QueryBlock;
      for (;;) {
        block = {
          kind: 'rows',
          version: this.version,
          index,
          rows: { kind: 'range', offset: first, count: n },
          position,
          columns: Object.fromEntries(
            query.select.map((field) => {
              const column = slice(table.columns[field]!, first, n);
              return [
                field,
                column.kind === 'reference'
                  ? { ...column, index: this.index(column.index.type) }
                  : column,
              ];
            }),
          ),
          ...(query.count ? { total } : {}),
          ...(query.ids
            ? {
                ids: text(
                  Array.from({ length: n }, (_, i) => query.from + ':' + (first + i)),
                ) as import('@latkit/model').TextColumn,
              }
            : {}),
        };
        if (options?.buffers === 'owned') block = owned(block);
        if (blockByteLength(block) <= bound) break;
        if (n <= 1) failure('resource-limit', 'One native row exceeds the block bound');
        n = Math.max(1, n >>> 1);
      }
      yield block;
      position += n;
    } while (position < length);
  }
}
