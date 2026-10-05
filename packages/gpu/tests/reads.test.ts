import { expect, it } from 'vitest';
import { createData, type FieldsBlock } from '@latkit/model';
import { createGpu } from '../src/index.js';
import {
  bindChannels,
  channelValue,
  channelValues,
  readRows,
  resolveChannel,
  resolveLabels,
  resolveScale,
} from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';

const index = { source: 'reads', type: 'node', version: '1' };
const data = createData(
  {
    types: {
      node: {
        fields: {
          load: { type: 'float32' },
          at: { type: { kind: 'vector', items: 'float64', size: 2 } },
        },
      },
    },
  },
  [
    {
      kind: 'rows',
      index,
      rows: { kind: 'range', offset: 0, count: 5 },
      columns: {
        load: { kind: 'numeric', offset: 0, length: 5, values: Float32Array.of(1, 2, NaN, 4, 5) },
        at: {
          kind: 'vector',
          size: 2,
          offset: 0,
          length: 5,
          values: {
            kind: 'numeric',
            offset: 0,
            length: 10,
            values: Float64Array.of(0, 10, 1, 11, 2, 12, 3, 13, 4, 14),
          },
        },
      },
    },
  ],
);

it('reads the rows a type selects, and its index', async () => {
  const gpu = await createGpu({ device: fakeDevice().device }),
    reader = gpu.reader.open();
  try {
    const all = await readRows(reader, data, 'node');
    expect(all.index).toEqual(index);
    expect([...all.rows]).toEqual([0, 1, 2, 3, 4]);
    const some = await readRows(reader, data, 'node', {
      kind: 'indices',
      index,
      values: Uint32Array.of(3, 1),
    });
    expect([...some.rows]).toEqual([3, 1]);
  } finally {
    reader.close();
    gpu.destroy();
  }
});

it('reads a channel at every row in one pass, as it reads each row', async () => {
  const gpu = await createGpu({ device: fakeDevice().device }),
    reader = gpu.reader.open();
  try {
    const { fields, channels } = bindChannels(
      {
        size: { field: 'load', domain: [0, 4], range: [0, 1] },
        x: 'at',
        y: { field: 'at', component: 1 },
      },
      { size: [0, 1], x: 'raw', y: 'raw' } as const,
    );
    let block!: FieldsBlock;
    for await (const tile of reader.fields({ source: data, from: 'node', fields })) block = tile;
    const size = resolveChannel(channels.size, resolveScale(channels.size.scale!, [0, 4]), -1),
      y = resolveChannel(channels.y, null, -1);
    for (const channel of [size, y]) {
      // Interleaved, two values a row from the second, as positions are laid out.
      const out = new Float64Array(11).fill(7);
      channelValues(channel, block, out, 1, 2);
      expect([...out].filter((_, i) => i % 2 === 1)).toEqual(
        [0, 1, 2, 3, 4].map((row) => channelValue(channel, block, row)),
      );
      expect([...out].filter((_, i) => i % 2 === 0)).toEqual(Array(6).fill(7));
    }
    // A missing value reads the fallback; values past the domain clamp as a scale does.
    expect(channelValue(size, block, 2)).toBe(-1);
    expect(channelValue(y, block, 4)).toBe(14);
  } finally {
    reader.close();
    gpu.destroy();
  }
});

it('takes labels as a field name or checked options', () => {
  expect(resolveLabels(null)).toBeUndefined();
  expect(resolveLabels('name')).toEqual({ field: 'name' });
  expect(resolveLabels({ field: 'name', maxCount: 3 })).toEqual({ field: 'name', maxCount: 3 });
  expect(() => resolveLabels({} as never)).toThrow('Invalid labels');
  expect(() => resolveLabels({ field: 'name', maxCount: -1 })).toThrow('Invalid label count');
  expect(() => resolveLabels({ field: 'name', color: [2, 0, 0, 1] })).toThrow();
});
