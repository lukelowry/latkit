import { expect, it } from 'vitest';
import { createData, createReader, type Data, type Index, type Schema } from '../src/index.js';

const index: Index = { source: 'reader', type: 'node', version: 'rows' };
const schema: Schema = {
  types: {
    node: {
      fields: {
        value: { type: 'float32' },
        position: { type: { kind: 'vector', items: 'float64', size: 2 } },
      },
    },
  },
};
function data(count = 8): Data {
  return createData(schema, [
    {
      kind: 'rows',
      index,
      rows: { kind: 'indices', values: Uint32Array.from({ length: count }, (_, i) => i) },
      columns: {
        value: {
          kind: 'numeric',
          offset: 0,
          length: count,
          values: Float32Array.from({ length: count }, (_, i) => i),
        },
        position: {
          kind: 'vector',
          offset: 0,
          length: count,
          size: 2,
          values: {
            kind: 'numeric',
            offset: 0,
            length: count * 2,
            values: Float64Array.from({ length: count * 2 }, (_, i) => 1e12 + i),
          },
        },
      },
    },
  ]);
}

it('resolves indexed fields and releases a closed scope', async () => {
  const source = data(),
    reader = createReader(),
    reads = reader.open();
  try {
    let tiles = 0;
    for await (const tile of reads.fields({
      source,
      from: index.type,
      rows: { index, kind: 'range', offset: 0, count: 8 },
      fields: { position: 'position', value: 'value' },
    })) {
      tiles++;
      expect(tile.columns.position.kind).toBe('vector');
      expect(tile.index).toEqual(index);
    }
    expect(tiles).toBeGreaterThan(0);
  } finally {
    reads.close();
    reads.close();
  }
  reader.trim();
  expect(reader.stats()).toMatchObject({ cpuBytes: 0, entries: 0 });
  await expect(async () => {
    for await (const _tile of reads.fields({
      source,
      from: index.type,
      fields: { value: 'value' },
    })) {
      throw new Error('Closed scope yielded data');
    }
  }).rejects.toMatchObject({ name: 'AbortError' });
  reader.destroy();
});

it('rejects reads from a canceled scope', async () => {
  const controller = new AbortController();
  controller.abort();
  const reader = createReader(),
    reads = reader.open({ signal: controller.signal });
  try {
    await expect(async () => {
      for await (const _tile of reads.fields({
        source: data(),
        from: index.type,
        fields: { value: 'value' },
      })) {
        throw new Error('Canceled scope yielded data');
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    reads.close();
    reader.destroy();
  }
});
