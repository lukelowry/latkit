import {
  createData,
  textColumn,
  type Data,
  type DataBatch,
  type Column,
  type NumericColumn,
} from '@latkit/model';
import type { DiagramRow } from '@latkit/diagram';
import { ports, schema, types, type Graph, type Block, type Wire } from './graph.js';
const numeric = (values: readonly number[], double = false): NumericColumn => ({
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
/** Each type's rows in order: what an index version numbers. */
function rows(graph: Graph): string {
  return JSON.stringify([
    graph.wires.map((wire) => wire.id),
    ...types.map((type) => graph.blocks.filter((block) => block.type === type).map((b) => b.id)),
  ]);
}
/** Application-owned graph and its current immutable columns. */
export class GraphSource {
  /** Changes when rows renumber, as blocks or wires come and go; items of other versions are stale. */
  version: string;
  /** Changes with every publish, so a long task can tell its graph is out of date. */
  revision = 0;
  data: Data;
  private serial = 0;
  constructor(
    public graph: Graph,
    private readonly sourceId: string = crypto.randomUUID(),
    version = '0',
  ) {
    this.version = version;
    this.data = this.materialize();
  }
  index(type: string, version = this.version) {
    return { source: this.sourceId, type, version };
  }
  publish(graph: Graph): void {
    // Values change in place; only new, removed, or reordered rows renumber.
    if (rows(graph) !== rows(this.graph)) this.version = String(++this.serial);
    this.graph = graph;
    this.revision++;
    this.data = this.materialize();
  }
  /** The diagram item of a block or wire id in the current data. */
  item(id: string): DiagramRow | undefined {
    const block = this.graph.blocks.find((candidate) => candidate.id === id);
    if (block) {
      const row = this.graph.blocks.filter((b) => b.type === block.type).indexOf(block);
      return { kind: 'vertex', source: this.data, index: this.index(block.type), row };
    }
    const row = this.graph.wires.findIndex((wire) => wire.id === id);
    return row < 0
      ? undefined
      : { kind: 'edge', source: this.data, index: this.index('Signal'), row };
  }
  private materialize(): Data {
    const wires = new Map(this.graph.wires.map((wire, row) => [wire.id, row]));
    const batches: DataBatch[] = [];
    for (const [type, definition] of Object.entries(schema.types)) {
      const rows =
        type === 'Signal'
          ? this.graph.wires
          : this.graph.blocks.filter((block) => block.type === type);
      const columns: Record<string, Column> = {};
      for (const name of Object.keys(definition.fields)) {
        if (type !== 'Signal' && name in ports[type as Block['type']]) {
          const values = new Uint32Array(rows.length),
            validity = new Uint8Array(Math.ceil(rows.length / 8));
          rows.forEach((row, i) => {
            const id = (row as Block).ports[name];
            if (id) {
              const target = wires.get(id);
              if (target === undefined) throw new Error('Unknown wire: ' + id);
              values[i] = target;
              validity[i >>> 3] |= 1 << (i & 7);
            }
          });
          columns[name] = {
            kind: 'reference',
            index: this.index('Signal'),
            offset: 0,
            length: rows.length,
            values,
            validity,
          };
        } else {
          const values = rows.map((row) => field(row, name));
          columns[name] =
            name === 'name'
              ? textColumn(values as string[])
              : name === 'position'
                ? {
                    kind: 'vector',
                    offset: 0,
                    length: rows.length,
                    size: 2,
                    values: numeric((values as (readonly number[])[]).flat(), true),
                  }
                : numeric(values as number[]);
        }
      }
      batches.push({
        kind: 'rows',
        index: this.index(type),
        rows: { kind: 'range', offset: 0, count: rows.length },
        ids: textColumn(rows.map((row) => row.id)),
        columns,
      });
    }
    return createData(schema, batches);
  }
}
