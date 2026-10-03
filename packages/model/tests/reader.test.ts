import { expect, it } from 'vitest';
import {
  createData,
  createMemory,
  createReader,
  type Data,
  type Index,
  type Schema,
} from '../src/index.js';

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

it('shares a borrowed memory pool, which outlives its readers', async () => {
  const memory = createMemory({ cpuBytes: 1024 ** 2 }),
    first = createReader({ memory }),
    second = createReader({ memory }),
    reads = first.open();
  try {
    for await (const tile of reads.fields({
      source: data(),
      from: index.type,
      fields: { value: 'value' },
    }))
      expect(tile.index).toEqual(index);
  } finally {
    reads.close();
  }
  const held = memory.stats().entries;
  expect(held).toBeGreaterThan(0);
  // Both readers report the pool they share, so one budget bounds them together.
  expect(second.stats()).toEqual(memory.stats());
  first.destroy();
  second.destroy();
  // The pool stays live for its owner: its other results remain, and a new reader reads into it.
  expect(memory.stats().entries).toBeGreaterThan(0);
  const third = createReader({ memory }),
    more = third.open();
  for await (const tile of more.fields({
    source: data(),
    from: index.type,
    fields: { value: 'value' },
  }))
    expect(tile.index).toEqual(index);
  more.close();
  third.destroy();
  memory.destroy();
  expect(memory.stats()).toMatchObject({ cpuBytes: 0, entries: 0 });
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

it('reads one sampled field bound by name and by binding without reading it twice', async () => {
  const sampled: Schema = {
    axis: { name: 'time' },
    types: { node: { fields: { signal: { type: 'float32', sampled: true } } } },
  };
  const frame = (f: number) => ({
    kind: 'samples' as const,
    index,
    rows: { kind: 'range' as const, offset: 0, count: 4 },
    firstFrame: f,
    coordinates: Float64Array.of(f),
    columns: {
      signal: {
        kind: 'numeric' as const,
        offset: 0,
        length: 4,
        values: Float32Array.from({ length: 4 }, (_, i) => f * 10 + i),
        rowStride: 1,
        frameStride: 4,
      },
    },
  });
  const source = createData(sampled, [
    { kind: 'rows', index, rows: { kind: 'range', offset: 0, count: 4 }, columns: {} },
    frame(0),
    frame(1),
  ]);
  const reader = createReader(),
    scope = reader.open();
  const blocks = [];
  for await (const block of scope.fields({
    source,
    from: 'node',
    window: { kind: 'frames', offset: 0, count: 2 },
    fields: { value: 'signal', shade: { source, from: 'node', field: 'signal' } },
  }))
    blocks.push(block);
  scope.close();
  expect(blocks).toHaveLength(1);
  expect(blocks[0].columns.shade).toEqual(blocks[0].columns.value);
  expect(reader.stats().queries).toBe(1);
  reader.destroy();
});
