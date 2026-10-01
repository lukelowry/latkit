import type {
  Queryable,
  Query,
  QueryOptions,
  QueryBlock,
  QueryHeader,
  Schema,
  Update,
  Column,
  RowSelection,
} from '@latkit/model';
import type { DiagramData } from '../src/data.js';
export interface End {
  node: number;
  port: string | null;
  role: string;
}
export class Source implements Queryable {
  version = 'v1';
  indexVersion = 'rows1';
  queries = 0;
  listeners = new Set<(change: Update) => void>();
  names: string[];
  xy: Float64Array;
  weights: Float32Array;
  ends: End[][];
  split = 2;
  malformed = false;
  schema: Schema = {
    queries: ['rows', 'endpoints'],
    limits: { maxBlockBytes: 1024 * 1024 },
    components: {
      Task: {
        fields: {
          name: { type: 'text' },
          position: { type: { kind: 'vector', items: 'float64', size: 2 } },
          weight: { type: 'float32' },
        },
        ports: { input: { direction: 'in' }, output: { direction: 'out' } },
      },
    },
    connections: {
      Dependency: {
        fields: { name: { type: 'text' }, weight: { type: 'float32' } },
        roles: { source: { min: 1, direction: 'out' }, target: { min: 1, direction: 'in' } },
      },
    },
  };
  constructor(readonly count = 4) {
    this.names = Array.from({ length: count }, (_, i) => 'Task ' + i);
    this.xy = Float64Array.from({ length: count * 2 }, (_, i) =>
      i % 2 ? Math.floor((i >> 1) / 4) * 160 : ((i >> 1) % 4) * 240,
    );
    this.weights = Float32Array.from({ length: count }, (_, i) => i / Math.max(1, count - 1));
    this.ends = Array.from({ length: Math.max(0, count - 1) }, (_, i) => [
      { node: i, port: 'output', role: 'source' },
      { node: i + 1, port: 'input', role: 'target' },
    ]);
  }
  index(type: string) {
    return { source: 'diagram-fixture', type, version: this.indexVersion };
  }
  describe(): Promise<Schema> {
    return Promise.resolve(this.schema);
  }
  on(_event: 'change', listener: (change: Update) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  update(): void {
    this.version += 'x';
    for (const fn of this.listeners) fn({ kind: 'replace', version: this.version });
  }
  close(): Promise<void> {
    for (const fn of this.listeners) fn({ kind: 'closed' });
    this.listeners.clear();
    return Promise.resolve();
  }
  retain(): Promise<Queryable> {
    const copy = new Source(this.count);
    copy.version = this.version;
    copy.indexVersion = this.indexVersion;
    copy.names = [...this.names];
    copy.xy = this.xy.slice();
    copy.weights = this.weights.slice();
    copy.ends = this.ends.map((e) => e.map((v) => ({ ...v })));
    return Promise.resolve(copy);
  }
  selection(type: string, rows?: RowSelection): number[] {
    const count = type === 'Task' ? this.count : this.ends.length;
    if (rows?.kind === 'ids') return rows.ids.map((id) => Number(id.slice(1)));
    if (rows?.kind === 'indices') return [...rows.values];
    return Array.from({ length: rows?.count ?? count }, (_, i) => i + (rows?.offset ?? 0));
  }
  query: Queryable['query'] = ((q: Query, o?: QueryOptions) =>
    this.read(q, o)) as Queryable['query'];
  private async *read(q: Query, o?: QueryOptions): AsyncGenerator<QueryHeader | QueryBlock> {
    this.queries++;
    o?.signal?.throwIfAborted();
    yield { kind: 'schema', version: this.version, schema: this.schema };
    const rows = this.selection(q.from, 'rows' in q ? q.rows : undefined);
    if (q.kind === 'rows') {
      const chosen = rows.slice(
        q.offset ?? 0,
        q.limit === undefined ? undefined : (q.offset ?? 0) + q.limit,
      );
      for (let first = 0; first < chosen.length; first += 32) {
        const selected = chosen.slice(first, first + 32),
          columns: Record<string, Column> = {};
        for (const field of q.select) {
          if (field === 'name')
            columns[field] = texts(
              selected.map((i) => (q.from === 'Task' ? this.names[i] : 'Flow ' + i)),
            );
          else if (field === 'position') {
            const values = Float64Array.from(
              selected.flatMap((i) => [this.xy[i * 2], this.xy[i * 2 + 1]]),
            );
            columns[field] = {
              kind: 'vector',
              offset: 0,
              length: selected.length,
              size: 2,
              values: { kind: 'numeric', offset: 0, length: values.length, values },
            };
          } else
            columns[field] = {
              kind: 'numeric',
              offset: 0,
              length: selected.length,
              values: Float32Array.from(selected, (i) => this.weights[i % this.weights.length]),
            };
        }
        yield {
          kind: 'rows',
          version: this.version,
          index: this.index(q.from),
          rows: { kind: 'indices', values: Uint32Array.from(selected) },
          position: first,
          columns,
          ...(q.ids
            ? { ids: texts(selected.map((i) => (q.from === 'Task' ? 'n' : 'e') + i)) }
            : {}),
        };
      }
    } else if (q.kind === 'endpoints') {
      for (const row of rows)
        for (let first = 0; first < this.ends[row].length; first += this.split) {
          const ends = this.ends[row].slice(first, first + this.split),
            ports = first % 2 ? [null, 'output', 'input'] : ['input', null, 'output'];
          yield {
            kind: 'endpoints',
            version: this.version,
            index: this.index(q.from),
            connections: Uint32Array.of(row),
            offsets: Int32Array.of(0, ends.length),
            firstEndpoint: Uint32Array.of(this.malformed ? first + 1 : first),
            totalEndpoints: Uint32Array.of(this.ends[row].length),
            componentIndexes: [this.index('Task')],
            componentType: new Uint32Array(ends.length),
            componentRow: Uint32Array.from(ends, (e) => e.node),
            portNames: ports,
            port: Uint32Array.from(ends, (e) => ports.indexOf(e.port)),
            roleNames: ['source', 'target'],
            role: Uint32Array.from(ends, (e) => (e.role === 'source' ? 0 : 1)),
          };
        }
    }
  }
}
export function texts(values: readonly string[]): import('@latkit/model').TextColumn {
  const parts = values.map((v) => new TextEncoder().encode(v)),
    offsets = new Int32Array(parts.length + 1);
  parts.forEach((p, i) => (offsets[i + 1] = offsets[i] + p.length));
  const bytes = new Uint8Array(offsets.at(-1)!);
  parts.forEach((p, i) => bytes.set(p, offsets[i]));
  return { kind: 'text', offset: 0, length: values.length, offsets, bytes };
}
export function data(source = new Source(), position = false): DiagramData {
  return {
    source,
    components: {
      Task: { labels: { field: 'name' }, ...(position ? { position: 'position' } : {}) },
    },
    connections: {
      Dependency: { route: 'orthogonal', arrows: ['target'], labels: { field: 'name' } },
    },
  };
}
export const measure = (input: { text: string }) =>
  Promise.resolve({ advance: [...input.text].length * 0.6, ascent: 0.8, descent: 0.2 });
