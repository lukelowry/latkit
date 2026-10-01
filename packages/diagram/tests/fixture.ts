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
/** One task port wired to a dependency net. */
export interface End {
  vertex: number;
  port: 'input' | 'output';
}
export class Source implements Queryable {
  version = 'v1';
  indexVersion = 'rows1';
  queries = 0;
  listeners = new Set<(change: Update) => void>();
  names: string[];
  xy: Float64Array;
  weights: Float32Array;
  /** Each dependency net's ends; a task port references the net that lists it. */
  ends: End[][];
  /** Serve the input port as numbers rather than references. */
  malformed = false;
  schema: Schema = {
    queries: ['rows'],
    limits: { maxBlockBytes: 1024 * 1024 },
    types: {
      Task: {
        fields: {
          name: { type: 'text' },
          position: { type: { kind: 'vector', items: 'float64', size: 2 } },
          weight: { type: 'float32' },
          input: {
            type: { kind: 'reference', to: 'Dependency' },
            nullable: true,
            direction: 'in',
          },
          output: {
            type: { kind: 'reference', to: 'Dependency' },
            nullable: true,
            direction: 'out',
          },
        },
      },
      Dependency: {
        fields: {
          name: { type: 'text' },
          weight: { type: 'float32' },
          from: { type: { kind: 'reference', to: 'Task' }, nullable: true },
          to: { type: { kind: 'reference', to: 'Task' }, nullable: true },
        },
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
      { vertex: i, port: 'output' },
      { vertex: i + 1, port: 'input' },
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
          else if (field === 'from' || field === 'to') {
            // A dependency's own ends: its output task and its first input task.
            const port = field === 'from' ? 'output' : 'input';
            const tasks = selected.map((net) => this.ends[net].find((end) => end.port === port));
            const validity = new Uint8Array(Math.ceil(selected.length / 8));
            tasks.forEach((task, at) => {
              if (task) validity[at >>> 3] |= 1 << (at & 7);
            });
            columns[field] = {
              kind: 'reference',
              index: this.index('Task'),
              offset: 0,
              length: selected.length,
              values: Uint32Array.from(tasks, (task) => task?.vertex ?? 0),
              validity,
            };
          } else if (field === 'input' || field === 'output') {
            const nets = new Uint32Array(selected.length),
              validity = new Uint8Array(Math.ceil(selected.length / 8));
            this.ends.forEach((ends, net) => {
              for (const end of ends) {
                const at = end.port === field ? selected.indexOf(end.vertex) : -1;
                if (at < 0) continue;
                nets[at] = net;
                validity[at >>> 3] |= 1 << (at & 7);
              }
            });
            columns[field] =
              this.malformed && field === 'input'
                ? { kind: 'numeric', offset: 0, length: selected.length, values: nets }
                : {
                    kind: 'reference',
                    index: this.index('Dependency'),
                    offset: 0,
                    length: selected.length,
                    values: nets,
                    validity,
                  };
          } else if (field === 'position') {
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
    vertices: {
      Task: { labels: { field: 'name' }, ...(position ? { position: 'position' } : {}) },
    },
    edges: {
      Dependency: { route: 'orthogonal', arrows: true, labels: { field: 'name' } },
    },
  };
}
export const measure = (input: { text: string }) =>
  Promise.resolve({ advance: [...input.text].length * 0.6, ascent: 0.8, descent: 0.2 });
