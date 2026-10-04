import { createData, read, type Data, type DataBatch } from '@latkit/model';
import type { Query, QueryOptions, RowsBlock, Schema, Column, RowSelection } from '@latkit/model';
import type { DiagramData, DiagramPort, DiagramRow } from '../src/data.js';
/** One task port wired to a dependency net. */
export interface End {
  vertex: number;
  port: 'input' | 'output';
}
export class Source {
  indexVersion = 'rows1';
  queries = 0;
  names: string[];
  xy: Float64Array;
  weights: Float32Array;
  /** Each dependency net's ends; a task port references the net that lists it. */
  ends: End[][];
  /** Serve the input port as numbers rather than references. */
  malformed = false;
  /** Number each dependency's own ends against an outdated task row space. */
  staleEnds = false;
  schema: Schema = {
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
  update(): void {
    this.cached = undefined;
  }
  private cached?: Data;
  get data(): Data {
    if (this.cached) return this.cached;
    const batches: DataBatch[] = [];
    for (const [from, type] of Object.entries(this.schema.types))
      for (const block of this.blocks({
        kind: 'rows',
        from,
        select: Object.keys(type.fields),
        ids: true,
      }))
        batches.push({
          kind: 'rows',
          index: block.index,
          rows: block.rows,
          columns: block.columns,
          ids: block.ids,
        });
    return (this.cached = createData(this.schema, batches));
  }
  selection(type: string, rows?: RowSelection): number[] {
    const count = type === 'Task' ? this.count : this.ends.length;
    if (rows?.kind === 'ids') return rows.ids.map((id) => Number(id.slice(1)));
    if (rows?.kind === 'indices') return [...rows.values];
    return Array.from({ length: rows?.count ?? count }, (_, i) => i + (rows?.offset ?? 0));
  }
  query<Q extends Query>(query: Q, options?: QueryOptions) {
    return read(this.data, query, options);
  }
  private *blocks(q: Query, o?: QueryOptions): Generator<RowsBlock> {
    this.queries++;
    o?.signal?.throwIfAborted();
    const rows = this.selection(q.from, 'rows' in q ? q.rows : undefined);
    if (q.kind === 'rows') {
      const ports = new Map<string, Map<number, number>>();
      if (q.from === 'Task')
        this.ends.forEach((ends, net) => {
          for (const end of ends) {
            let vertices = ports.get(end.port);
            if (!vertices) ports.set(end.port, (vertices = new Map<number, number>()));
            vertices.set(end.vertex, net);
          }
        });
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
              index: this.staleEnds
                ? { ...this.index('Task'), version: 'stale' }
                : this.index('Task'),
              offset: 0,
              length: selected.length,
              values: Uint32Array.from(tasks, (task) => task?.vertex ?? 0),
              validity,
            };
          } else if (field === 'input' || field === 'output') {
            const nets = new Uint32Array(selected.length),
              validity = new Uint8Array(Math.ceil(selected.length / 8));
            selected.forEach((vertex, at) => {
              const net = ports.get(field)?.get(vertex);
              if (net === undefined) return;
              nets[at] = net;
              validity[at >>> 3] |= 1 << (at & 7);
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
          index: this.index(q.from),
          rows: selected.every((row, i) => row === selected[0] + i)
            ? { kind: 'range', offset: selected[0] ?? 0, count: selected.length }
            : { kind: 'indices', values: Uint32Array.from(selected) },
          rowOffset: first,
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
/** The item an app finds for an id: fixture ids name their row, as `n2` for a task or `e0` for a dependency. */
export function vertex(source: Source, id: string): DiagramRow {
  return {
    kind: 'vertex',
    source: source.data,
    index: source.index('Task'),
    row: Number(id.slice(1)),
  };
}
export function edge(source: Source, id: string): DiagramRow {
  return {
    kind: 'edge',
    source: source.data,
    index: source.index('Dependency'),
    row: Number(id.slice(1)),
  };
}
export function port(source: Source, id: string, name: string): DiagramPort {
  return { ...vertex(source, id), kind: 'port', port: name };
}
export function data(source = new Source(), position = false): DiagramData {
  return {
    source: source.data,
    vertices: {
      Task: { labels: { field: 'name' }, ...(position ? { position: 'position' } : {}) },
    },
    edges: {
      Dependency: { route: 'orthogonal', arrows: true, labels: { field: 'name' } },
    },
  };
}
export const layoutText = (
  input: import('@latkit/gpu').TextLayoutInput,
): Promise<import('@latkit/gpu').TextLayout> => {
  const size = input.size ?? 12;
  return Promise.resolve({
    runs: [
      { text: input.text, font: input.font, color: input.color, size, position: [0, size * 0.8] },
    ],
    width: [...input.text].length * 0.6 * size,
    height: size,
    ascent: size * 0.8,
    descent: size * 0.2,
  });
};
