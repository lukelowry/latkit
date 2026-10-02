import { locateSample, samplePages } from '../read.js';
import type { ColumnPage, Data, TableData } from '../materialized.js';
import type { RowAxis, RowSelection } from '../data.js';
import type { Query, SampleWindow } from '../query.js';
import type { Schema } from '../schema.js';

/** One identity space for every cache key: the immutable values a computation actually reads. */
export class Keys {
  private readonly objects = new WeakMap<object, number>();
  private readonly pageKeys = new WeakMap<readonly ColumnPage[], string>();
  private readonly tableKeys = new WeakMap<TableData, WeakMap<Schema, string>>();
  private serial = 0;

  id(value: object | undefined): number {
    if (!value) return 0;
    let id = this.objects.get(value);
    if (!id) {
      id = ++this.serial;
      this.objects.set(value, id);
    }
    return id;
  }
  axis(rows: RowAxis): unknown {
    return rows.kind === 'range'
      ? ['range', rows.offset, rows.count]
      : ['indices', this.id(rows.values.buffer), rows.values.byteOffset, rows.values.length];
  }
  selection(rows?: RowSelection): string {
    return JSON.stringify(
      !rows
        ? null
        : rows.kind === 'ids'
          ? ['ids', this.id(rows.ids)]
          : [this.axis(rows), rows.index],
    );
  }

  table(data: Data, from: string): string {
    const table = data.tables[from];
    let schemas = table && this.tableKeys.get(table);
    const cached = schemas?.get(data.schema);
    if (cached !== undefined) return cached;
    const key = this.key([this.id(data.schema), table?.index, table?.rows, this.id(table?.ids)]);
    if (table) {
      if (!schemas) this.tableKeys.set(table, (schemas = new WeakMap()));
      schemas.set(data.schema, key);
    }
    return key;
  }

  field(data: Data, from: string, name: string, window?: SampleWindow): string {
    const pages = data.tables[from]?.fields[name];
    const definition = data.schema.types[from]?.fields[name];
    let selected: unknown = this.id(pages);
    if (definition?.sampled && pages && window?.kind === 'at') {
      const sample = locateSample(pages, window.value);
      selected = sample ? [this.pages(sample.pages), sample.frame] : null;
    } else if (definition?.sampled && pages && window?.kind === 'frames') {
      selected = Array.from(samplePages(pages, window), (page) => this.id(page)).join(',');
    }
    const type = definition?.type;
    const reference =
      typeof type === 'object' && type.kind === 'reference'
        ? [data.tables[type.to]?.index, this.id(data.tables[type.to]?.ids)]
        : null;
    return this.key([selected, reference]);
  }

  query(data: Data, query: Query): string {
    const used = new Set(query.select);
    if (query.kind === 'rows') {
      for (const filter of query.where ?? []) used.add(filter.field);
      for (const order of query.orderBy ?? []) used.add(order.field);
    }
    const window =
      query.kind === 'rows'
        ? query.at !== undefined
          ? { kind: 'at' as const, value: query.at }
          : undefined
        : query.window;
    // Keep the request intact for execution. Only the key uses the resolved observation.
    const point = window?.kind === 'at' && Number.isFinite(window.value);
    const request = point
      ? query.kind === 'rows'
        ? { ...query, at: 'resolved' }
        : { ...query, window: { kind: 'at' } }
      : query;
    return this.key([
      this.table(data, query.from),
      [...used].sort().map((name) => [name, this.field(data, query.from, name, window)]),
      request,
    ]);
  }

  private pages(pages: readonly ColumnPage[]): string {
    let key = this.pageKeys.get(pages);
    if (key === undefined) {
      key = pages.map((page) => this.id(page)).join(',');
      this.pageKeys.set(pages, key);
    }
    return key;
  }
  private key(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (ArrayBuffer.isView(value)) return '@' + this.id(value);
    if ('kind' in value && value.kind === 'ids' && 'ids' in value && Array.isArray(value.ids)) {
      const { ids, ...rest } = value;
      return this.key(rest) + ':ids@' + this.id(ids);
    }
    if (Array.isArray(value)) return '[' + value.map((item) => this.key(item)).join(',') + ']';
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => JSON.stringify(name) + ':' + this.key(item))
        .join(',') +
      '}'
    );
  }
}
