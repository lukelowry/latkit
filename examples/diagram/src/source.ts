import { assertIndex, blockByteLength, validateQuery } from '@latkit/model';
import type {
  Queryable,
  Query,
  QueryOptions,
  QueryHeader,
  QueryBlock,
  Column,
  ReferenceColumn,
  TextColumn,
  Update,
  RowSelection,
  Filter,
  RequestOptions,
  RetainOptions,
} from '@latkit/model';
import { ports, schema, type Graph, type Block, type Wire } from './graph.js';
function text(values: readonly string[]): TextColumn {
  const pieces = values.map((value) => new TextEncoder().encode(value));
  const offsets = new Int32Array(values.length + 1);
  pieces.forEach((part, i) => {
    offsets[i + 1] = offsets[i] + part.length;
  });
  const bytes = new Uint8Array(offsets.at(-1)!);
  pieces.forEach((part, i) => bytes.set(part, offsets[i]));
  return { kind: 'text', offset: 0, length: values.length, offsets, bytes };
}
const numeric = (values: number[], double = false): import('@latkit/model').NumericColumn => ({
  kind: 'numeric',
  offset: 0,
  length: values.length,
  values: double ? Float64Array.from(values) : Float32Array.from(values),
});
function field(row: Block | Wire, name: string): string | number | readonly [number, number] {
  if (name === 'name') return row.name;
  if (name === 'position' && 'position' in row) return row.position;
  if (name === 'signal') return row.signal;
  if (name === 'status' && 'status' in row) return row.status;
  if (name === 'visible' && 'visible' in row) return row.visible;
  throw new Error('Unknown field: ' + name);
}
function matches(value: ReturnType<typeof field>, filter: Filter): boolean {
  switch (filter.operator) {
    case 'equal':
      return value === filter.value;
    case 'notEqual':
      return value !== filter.value;
    case 'contains':
      return String(value).includes(filter.value);
    case 'lessThan':
      return Number(value) < filter.value;
    case 'lessThanOrEqual':
      return Number(value) <= filter.value;
    case 'greaterThan':
      return Number(value) > filter.value;
    case 'greaterThanOrEqual':
      return Number(value) >= filter.value;
  }
}
/** Immutable graph snapshots implement the same native contract used by every renderer. */
export class GraphSource implements Queryable {
  private listeners = new Set<(update: Update) => void>();
  private stopped = new AbortController();
  private serial = 0;
  private sourceId: string;
  version: string;
  constructor(
    public graph: Graph,
    id: string = crypto.randomUUID(),
    version = '0',
  ) {
    this.sourceId = id;
    this.version = version;
  }
  publish(graph: Graph): void {
    this.stopped.signal.throwIfAborted();
    this.graph = graph;
    this.version = String(++this.serial);
    for (const listener of this.listeners) listener({ kind: 'replace', version: this.version });
  }
  index(type: string, version = this.version) {
    return { source: this.sourceId, type, version };
  }
  describe(options?: RequestOptions): Promise<typeof schema> {
    options?.signal?.throwIfAborted();
    this.stopped.signal.throwIfAborted();
    return Promise.resolve(schema);
  }
  on(_event: 'change', listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  retain(options?: RetainOptions): Promise<Queryable> {
    options?.signal?.throwIfAborted();
    this.stopped.signal.throwIfAborted();
    if (options?.maxBytes !== undefined && JSON.stringify(this.graph).length * 2 > options.maxBytes)
      return Promise.reject(new Error('Retained graph exceeds the requested memory budget.'));
    return Promise.resolve(new GraphSource(this.graph, this.sourceId, this.version));
  }
  close(): Promise<void> {
    if (!this.stopped.signal.aborted) {
      this.stopped.abort(new DOMException('Source closed', 'AbortError'));
      for (const listener of this.listeners) listener({ kind: 'closed' });
      this.listeners.clear();
    }
    return Promise.resolve();
  }
  query: Queryable['query'] = ((query: Query, options?: QueryOptions) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options?: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    const graph = this.graph,
      version = this.version;
    const signal = AbortSignal.any([
      this.stopped.signal,
      ...(options?.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const problems = validateQuery(schema, query);
    if (problems.length) throw new Error(problems.map((problem) => problem.message).join('; '));
    const budget = Math.min(options?.maxBlockBytes ?? 1024 ** 2, 1024 ** 2);
    if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid block budget.');
    const rows =
      query.from === 'Signal'
        ? graph.wires
        : graph.blocks.filter((block) => block.type === query.from);
    const wireRows = new Map(graph.wires.map((wire, row) => [wire.id, row]));
    /** A port's column: the row of the wire each block is plugged into. */
    const plugs = (indices: readonly number[], port: string): ReferenceColumn => {
      const values = new Uint32Array(indices.length),
        validity = new Uint8Array(Math.ceil(indices.length / 8));
      indices.forEach((i, at) => {
        const wire = (rows[i] as Block).ports[port];
        if (!wire) return;
        values[at] = wireRows.get(wire)!;
        validity[at >>> 3] |= 1 << (at & 7);
      });
      return {
        kind: 'reference',
        index: this.index('Signal', version),
        offset: 0,
        length: indices.length,
        values,
        validity,
      };
    };
    const choose = (selection?: RowSelection): number[] => {
      if (selection && 'index' in selection && selection.index)
        assertIndex(this.index(query.from, version), selection.index);
      if (!selection) return rows.map((_, i) => i);
      const indices =
        selection.kind === 'ids'
          ? selection.ids.map((id) => rows.findIndex((row) => row.id === id))
          : selection.kind === 'indices'
            ? [...selection.values]
            : Array.from({ length: selection.count }, (_, i) => selection.offset + i);
      if (indices.some((i) => i < 0 || i >= rows.length))
        throw new Error('Unknown row in selection.');
      return indices;
    };
    let selected = choose('rows' in query ? query.rows : undefined);
    yield { kind: 'schema', version, schema };
    if (query.kind === 'rows') {
      if (query.where)
        selected = selected.filter((i) =>
          query.where!.every((filter) => matches(field(rows[i], filter.field), filter)),
        );
      if (query.orderBy)
        selected.sort((a, b) => {
          for (const order of query.orderBy!) {
            const x = field(rows[a], order.field),
              y = field(rows[b], order.field);
            const result = x < y ? -1 : x > y ? 1 : 0;
            if (result) return order.direction === 'descending' ? -result : result;
          }
          return a - b;
        });
      const total = selected.length;
      selected = selected.slice(
        query.offset ?? 0,
        query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit,
      );
      let position = 0;
      do {
        signal.throwIfAborted();
        let size = Math.min(64, selected.length - position),
          block: QueryBlock;
        for (;;) {
          const indices = selected.slice(position, position + size);
          const columns: Record<string, Column> = {};
          for (const name of query.select) {
            if (query.from !== 'Signal' && name in ports[query.from as Block['type']]) {
              columns[name] = plugs(indices, name);
              continue;
            }
            const values = indices.map((i) => field(rows[i], name));
            columns[name] =
              name === 'name'
                ? text(values as string[])
                : name === 'position'
                  ? {
                      kind: 'vector',
                      offset: 0,
                      length: size,
                      size: 2,
                      values: numeric((values as (readonly number[])[]).flat(), true),
                    }
                  : numeric(values as number[]);
          }
          block = {
            kind: 'rows',
            version,
            index: this.index(query.from, version),
            rows: { kind: 'indices', values: Uint32Array.from(indices) },
            position,
            columns,
            ...(query.ids ? { ids: text(indices.map((i) => rows[i].id)) } : {}),
            ...(query.count ? { total } : {}),
          };
          if (blockByteLength(block) <= budget) break;
          if (size <= 1) throw new Error('A row exceeds the requested block budget.');
          size = Math.floor(size / 2);
        }
        yield block;
        position += size;
        if (position < selected.length)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } while (position < selected.length);
    }
    signal.throwIfAborted();
  }
}
