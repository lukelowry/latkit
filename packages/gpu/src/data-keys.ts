import {
  locateSample,
  samplePages,
  type ColumnPage,
  type Data,
  type Query,
  type SampleWindow,
  type TableData,
  type Schema,
} from '@latkit/model';

/** Identity of the immutable values a computation actually reads, independent of publications. */
export class DataKeys {
  private readonly objects = new WeakMap<object, number>();
  private readonly pageKeys = new WeakMap<readonly ColumnPage[], string>();
  private readonly tableKeys = new WeakMap<TableData, WeakMap<Schema, string>>();
  private serial = 0;

  table(data: Data, from: string): string {
    const table = data.tables[from];
    let schemas = table && this.tableKeys.get(table);
    const cached = schemas?.get(data.schema);
    if (cached !== undefined) return cached;
    const key = this.key([
      this.identity(data.schema),
      table?.index,
      table?.rows,
      this.identity(table?.ids),
    ]);
    if (table) {
      if (!schemas) this.tableKeys.set(table, (schemas = new WeakMap()));
      schemas.set(data.schema, key);
    }
    return key;
  }

  field(data: Data, from: string, name: string, window?: SampleWindow): string {
    const pages = data.tables[from]?.fields[name];
    const definition = data.schema.types[from]?.fields[name];
    let selected: unknown = this.identity(pages);
    if (definition?.sampled && pages && window?.kind === 'at') {
      const sample = locateSample(pages, window.value);
      selected = sample ? [this.pages(sample.pages), sample.frame] : null;
    } else if (definition?.sampled && pages && window?.kind === 'frames') {
      selected = Array.from(samplePages(pages, window), (page) => this.identity(page)).join(',');
    }

    const type = definition?.type;
    const reference =
      typeof type === 'object' && type.kind === 'reference'
        ? [data.tables[type.to]?.index, this.identity(data.tables[type.to]?.ids)]
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
    // Keep the request intact for validation/execution. Only the cache key uses resolved samples.
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
      key = pages.map((page) => this.identity(page)).join(',');
      this.pageKeys.set(pages, key);
    }
    return key;
  }
  private identity(value: object | undefined): number {
    if (!value) return 0;
    let id = this.objects.get(value);
    if (!id) {
      id = ++this.serial;
      this.objects.set(value, id);
    }
    return id;
  }
  private key(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (ArrayBuffer.isView(value)) return '@' + this.identity(value);
    if ('kind' in value && value.kind === 'ids' && 'ids' in value && Array.isArray(value.ids)) {
      const { ids, ...rest } = value;
      return this.key(rest) + ':ids@' + this.identity(ids);
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
