import { validateQuery } from '@latkit/model';
import type {
  Column,
  Queryable,
  Query,
  QueryOptions,
  QueryHeader,
  QueryBlock,
  Schema,
  Update,
  Index,
} from '@latkit/model';

/** Immutable native Queryable used by unit tests and the headed path benchmark. */
export class PathSource implements Queryable {
  readonly version = 'paths-1';
  readonly schema: Schema;
  readonly listeners = new Set<(update: Update) => void>();
  queries = 0;
  constructor(
    readonly tables: Readonly<Record<string, Readonly<Record<string, Column>>>>,
    readonly endpoints: Readonly<Record<string, readonly (readonly [string, number][])[]>> = {},
    readonly blockRows = 256,
  ) {
    const type = (column: Column): import('@latkit/model').DataType => {
      if (column.kind === 'list') return { kind: 'list', items: type(column.values) };
      if (column.kind === 'vector')
        return {
          kind: 'vector',
          size: column.size,
          items: column.values.values instanceof Float64Array ? 'float64' : 'float32',
        };
      if (column.kind === 'numeric')
        return column.values instanceof Float64Array ? 'float64' : 'float32';
      return column.kind;
    };
    const components: Record<string, import('@latkit/model').ComponentDefinition> = {},
      connections: Record<string, import('@latkit/model').ConnectionDefinition> = {};
    for (const [name, columns] of Object.entries(tables)) {
      const fields = Object.fromEntries(
        Object.entries(columns).map(([name, column]) => [
          name,
          { type: type(column), nullable: !!column.validity },
        ]),
      );
      if (endpoints[name]) connections[name] = { fields, roles: { member: { min: 0 } } };
      else components[name] = { fields };
    }
    this.schema = {
      limits: { maxBlockBytes: 4 * 1024 * 1024 },
      queries: ['rows', 'endpoints'],
      components,
      connections,
    };
  }
  index(type: string): Index {
    return { source: 'paths-fixture', type, version: 'rows-1' };
  }
  describe(): Promise<Schema> {
    return Promise.resolve(this.schema);
  }
  retain(): Promise<Queryable> {
    return Promise.resolve(new PathSource(this.tables, this.endpoints, this.blockRows));
  }
  close(): Promise<void> {
    for (const listener of this.listeners) listener({ kind: 'closed' });
    this.listeners.clear();
    return Promise.resolve();
  }
  on(_: 'change', listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  query: Queryable['query'] = ((query: Query, options?: QueryOptions) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options?: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    const issues = validateQuery(this.schema, query);
    if (issues.length) throw new Error(JSON.stringify(issues));
    this.queries++;
    options?.signal?.throwIfAborted();
    yield { kind: 'schema', version: this.version, schema: this.schema };
    const columns = this.tables[query.from],
      count = this.endpoints[query.from]?.length ?? Object.values(columns)[0].length;
    const selection = query.rows;
    if (selection?.kind === 'ids') throw new Error('Fixture has no string IDs');
    const selected =
      selection?.kind === 'indices'
        ? Array.from(selection.values)
        : Array.from({ length: selection?.count ?? count }, (_, i) => (selection?.offset ?? 0) + i);
    for (let first = 0; first < selected.length;) {
      options?.signal?.throwIfAborted();
      let n = Math.min(this.blockRows, selected.length - first);
      if (selection?.kind === 'indices') n = 1;
      const row = selected[first],
        index = this.index(query.from),
        base = { version: this.version, index };
      if (query.kind === 'rows') {
        let size = 0;
        n = 0;
        for (; n < Math.min(this.blockRows, selected.length - first); n++) {
          if (n && selected[first + n] !== row + n) break;
          let bytes = 4;
          for (const field of query.select) {
            const c = columns[field],
              at = c.offset + selected[first + n];
            bytes +=
              c.kind === 'list'
                ? (c.offsets[at + 1] - c.offsets[at]) *
                    (c.values.kind === 'vector' ? c.values.size : 1) *
                    8 +
                  4
                : c.kind === 'text'
                  ? c.offsets[at + 1] - c.offsets[at] + 4
                  : 32;
          }
          const limit = Math.min(
            options?.maxBlockBytes ?? Infinity,
            this.schema.limits.maxBlockBytes,
          );
          if (bytes > limit)
            throw Object.assign(new Error('Fixture cell exceeds block bound'), {
              code: 'resource-limit',
            });
          if (n && size + bytes > limit) break;
          size += bytes;
        }
        yield {
          ...base,
          kind: 'rows',
          position: first,
          rows: { kind: 'range', offset: row, count: n },
          columns: Object.fromEntries(
            query.select.map((field) => [
              field,
              { ...columns[field], offset: columns[field].offset + row, length: n },
            ]),
          ),
        };
      } else if (query.kind === 'endpoints') {
        n = 1;
        const ends = this.endpoints[query.from][row],
          types = [...new Set(ends.map((e) => e[0]))];
        // Deliberately split endpoint lists to exercise native CSR continuation.
        for (let e = 0; e < Math.max(1, ends.length); e += 2) {
          const part = ends.slice(e, e + 2);
          yield {
            ...base,
            kind: 'endpoints',
            connections: Uint32Array.of(row),
            offsets: Int32Array.of(0, part.length),
            firstEndpoint: Uint32Array.of(e),
            totalEndpoints: Uint32Array.of(ends.length),
            componentIndexes: types.map((t) => this.index(t)),
            componentType: Uint32Array.from(part, (p) => types.indexOf(p[0])),
            componentRow: Uint32Array.from(part, (p) => p[1]),
            portNames: [null],
            port: new Uint32Array(part.length),
            roleNames: ['member'],
            role: new Uint32Array(part.length),
          };
        }
      } else throw new Error('Unsupported fixture query');
      first += n;
    }
  }
}
export function vectors(values: readonly number[]): import('@latkit/model').VectorColumn {
  const data = Float64Array.from(values);
  return {
    kind: 'vector',
    offset: 0,
    length: data.length / 2,
    size: 2,
    values: { kind: 'numeric', offset: 0, length: data.length, values: data },
  };
}
export function lists(paths: readonly (readonly number[])[]): import('@latkit/model').ListColumn {
  const offsets = new Int32Array(paths.length + 1);
  for (let i = 0; i < paths.length; i++) offsets[i + 1] = offsets[i] + paths[i].length / 2;
  return {
    kind: 'list',
    offset: 0,
    length: paths.length,
    offsets,
    values: vectors(paths.flatMap((p) => [...p])),
  };
}
export function strings(values: readonly string[]): import('@latkit/model').TextColumn {
  const encoded = values.map((v) => new TextEncoder().encode(v)),
    offsets = new Int32Array(values.length + 1);
  for (let i = 0; i < encoded.length; i++) offsets[i + 1] = offsets[i] + encoded[i].length;
  const bytes = new Uint8Array(offsets[values.length]);
  encoded.forEach((v, i) => bytes.set(v, offsets[i]));
  return { kind: 'text', offset: 0, length: values.length, offsets, bytes };
}
export function featureSource(): PathSource {
  return new PathSource(
    {
      node: {
        position: vectors([-70, -20, -30, -10, -60, 30, 20, 40]),
        name: strings(['West', 'East', 'North', 'Distant']),
      },
      bend: { points: lists([[-60, 0, -40, 0]]), name: strings(['Bent connection']) },
      star: { name: strings(['Four-way junction']) },
      route: { name: strings(['Great circle']) },
      seam: { points: lists([[170, 20, -170, 20]]), name: strings(['Dateline']) },
    },
    {
      bend: [
        [
          ['node', 0],
          ['node', 1],
        ],
      ],
      star: [
        [
          ['node', 0],
          ['node', 1],
          ['node', 2],
          ['node', 3],
        ],
      ],
      route: [
        [
          ['node', 0],
          ['node', 3],
        ],
      ],
    },
    2,
  );
}
