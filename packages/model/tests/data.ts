import type {
  Index,
  NumericColumn,
  ReferenceColumn,
  RowsBlock,
  Schema,
  TextColumn,
} from '../src/index.js';

export const index: Index = { source: 'model', type: 'Node', version: 'rows:1' };
export const hubs: Index = { source: 'model', type: 'Hub', version: 'rows:1' };
export const schema: Schema = {
  queries: ['rows', 'samples', 'aggregate'],
  limits: { maxBlockBytes: 65536 },
  types: {
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
        hub: { type: { kind: 'reference', to: 'Hub' }, direction: 'out' },
      },
      spatial: { field: 'position', system: 'cartesian' },
    },
    Hub: { fields: {} },
    Settings: { fields: { value: { type: 'float64' } } },
  },
  axis: { name: 'time', unit: 's' },
};

export function numbers(values: readonly number[]): NumericColumn {
  return { kind: 'numeric', values: Float64Array.from(values), offset: 0, length: values.length };
}
export function references(
  values: readonly (number | null)[],
  target: Index = index,
): ReferenceColumn {
  const validity = new Uint8Array(Math.ceil(values.length / 8));
  values.forEach((value, i) => {
    if (value !== null) validity[i >>> 3] |= 1 << (i & 7);
  });
  return {
    kind: 'reference',
    index: target,
    values: Uint32Array.from(values, (value) => value ?? 0),
    offset: 0,
    length: values.length,
    ...(values.includes(null) ? { validity } : {}),
  };
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
