import type { Index, NumericColumn, RowsBlock, Schema, TextColumn } from '../src/index.js';

export const index: Index = { source: 'model', type: 'Node', version: 'rows:1' };
export const schema: Schema = {
  queries: ['rows', 'samples', 'endpoints', 'links', 'aggregate'],
  limits: { maxBlockBytes: 65536 },
  components: {
    Node: {
      fields: {
        value: {
          type: 'float64',
          bounds: { lower: { value: 0, inclusive: false } },
        },
        label: { type: 'text', nullable: true },
        enabled: { type: 'boolean' },
        output: { type: 'float64', sampled: true },
        position: { type: { kind: 'vector', items: 'float64', size: 2 }, nullable: true },
        route: {
          type: { kind: 'list', items: { kind: 'vector', items: 'float64', size: 2 } },
          nullable: true,
        },
        parent: { type: { kind: 'reference', to: 'Node' }, nullable: true },
      },
      ports: { a: { direction: 'both' }, b: { direction: 'both' } },
      spatial: { field: 'position', system: 'local' },
    },
  },
  connections: {
    Relation: {
      fields: {},
      roles: { member: { min: 2 } },
    },
  },
  tables: {
    Settings: { fields: { value: { type: 'float64' } } },
  },
  axis: { name: 'time', unit: 's' },
};

export function numbers(values: readonly number[]): NumericColumn {
  return { kind: 'numeric', values: Float64Array.from(values), offset: 0, length: values.length };
}
export function text(values: readonly string[]): TextColumn {
  const encoder = new TextEncoder();
  const encoded = values.map((v) => encoder.encode(v));
  const offsets = new Int32Array(values.length + 1);
  for (let i = 0; i < values.length; i++) offsets[i + 1] = offsets[i] + encoded[i].length;
  const bytes = new Uint8Array(offsets[values.length]);
  for (let i = 0; i < values.length; i++) bytes.set(encoded[i], offsets[i]);
  return { kind: 'text', bytes, offsets, offset: 0, length: values.length };
}
export function rows(): RowsBlock {
  return {
    kind: 'rows',
    version: 'data:1',
    index,
    rows: { kind: 'range', offset: 0, count: 2 },
    position: 0,
    columns: { value: numbers([10, 20]) },
  };
}
