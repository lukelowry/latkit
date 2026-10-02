import { expect, it } from 'vitest';
import {
  appendData,
  createData,
  textColumn,
  type RowsBlock,
  type NumericColumn,
  type SampleBatch,
  type Schema,
} from '@latkit/model';
import { createGpu } from '../src/index.js';
import type { GpuPage, FieldsRequest } from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { field, values } from './fixtures/fields.js';
import { renderer, target } from './fixtures/render.js';

const index = { source: 'sample-cache', type: 'node', version: 'rows' };
const rows = { kind: 'range', offset: 0, count: 2 } as const;
const schema: Schema = {
  limits: { maxBlockBytes: 65536 },
  axis: { name: 'time' },
  types: {
    node: {
      fields: {
        static: { type: 'float32' },
        a: { type: 'float32', sampled: true },
        b: { type: 'float32', sampled: true },
      },
    },
  },
};
function samples(
  name: string,
  firstFrame: number,
  coordinates: number[],
  values: number[],
): SampleBatch {
  return {
    kind: 'samples',
    index,
    rows,
    firstFrame,
    coordinates: Float64Array.from(coordinates),
    columns: {
      [name]: {
        kind: 'numeric',
        offset: 0,
        length: values.length,
        values: Float32Array.from(values),
        rowStride: 1,
        frameStride: 2,
      },
    },
  };
}
function data() {
  return createData(schema, 'v1', [
    {
      kind: 'rows',
      index,
      rows,
      ids: textColumn(['left', 'right']),
      columns: {
        static: { kind: 'numeric', offset: 0, length: 2, values: Float32Array.of(100, 200) },
      },
    },
    samples('a', 10, [0, 1], [1, 2, 3, 4]),
    samples('b', 20, [0.5, 2], [10, 20, 30, 40]),
  ]);
}
async function collect(stream: AsyncIterable<unknown>): Promise<RowsBlock[]> {
  const blocks: RowsBlock[] = [];
  for await (const value of stream)
    if ((value as RowsBlock).kind === 'rows') blocks.push(value as RowsBlock);
  return blocks;
}
function numbers(blocks: RowsBlock[], name: string) {
  return blocks.flatMap((block) => {
    const column = block.columns[name] as NumericColumn;
    return Array.from(column.values.subarray(column.offset, column.offset + column.length));
  });
}

it('keys local queries by every selected, filtered, and ordered sample with independent coordinates', async () => {
  const source = data(),
    gpu = await createGpu({ device: fakeDevice().device });
  const query = {
    kind: 'rows',
    from: 'node',
    select: ['a'],
    where: [{ field: 'b', operator: 'greaterThan', value: 15 }],
    orderBy: [{ field: 'b', direction: 'descending' }],
  } as const;
  expect(numbers(await collect(gpu.query(source, { ...query, at: 1.1 })), 'a')).toEqual([4]);
  const before = gpu.stats().queries;
  expect(numbers(await collect(gpu.query(source, { ...query, at: 1.9 })), 'a')).toEqual([4]);
  expect(gpu.stats().queries).toBe(before);
  expect(numbers(await collect(gpu.query(source, { ...query, at: 2 })), 'a')).toEqual([4, 3]);
  expect(gpu.stats().queries).toBe(before + 1);
  gpu.destroy();
});

it.each(['indexed', 'discovered', 'ids'] as const)(
  'reuses %s field buffers, uploads, and automatic domains while the selected sample is unchanged',
  async (mode) => {
    let source = data();
    const gpu = await createGpu({ device: fakeDevice().device });
    const output = target(gpu.device);
    const selected =
      mode === 'indexed'
        ? { ...rows, index }
        : mode === 'ids'
          ? { kind: 'ids' as const, ids: ['right', 'left'] }
          : undefined;
    const pages: GpuPage[][] = [];
    const read = async (at: number) => {
      const request: FieldsRequest = {
        source,
        from: 'node',
        rows: selected,
        fields: { color: 'a', height: 'a', static: 'static' },
      };
      const result: GpuPage[] = [];
      await gpu.render({
        timeMs: at,
        views: [
          {
            target: output,
            at,
            renderer: renderer(async (frame) => {
              for await (const native of frame.fields(request)) {
                expect(native.versions.get(source)).toBe(source.version);
                result.push(
                  ...frame.upload(native, {
                    select: Object.keys(native.columns),
                    float64: 'relative',
                  }),
                );
              }
              expect(
                (await frame.scale({ source, from: 'node', rows: selected, field: 'a' })).domain,
              ).toEqual(at >= 4 ? [5, 6] : [3, 4]);
            }),
          },
        ],
      });
      await gpu.idle();
      pages.push(result);
      return gpu.stats();
    };
    const before = await read(1.1);
    const warm = await read(1.9);
    expect(warm.queries).toBe(before.queries);
    expect(warm.uploadedBytes).toBe(before.uploadedBytes);
    expect(field(pages[1][0], 'color').binding).toEqual(field(pages[0][0], 'color').binding);
    expect(field(pages[1][0], 'height').binding).toEqual(field(pages[1][0], 'color').binding);
    const previous = source;
    source = appendData(source, 'v2', [samples('a', 12, [4], [5, 6])]);
    const appended = await read(1.2);
    expect(appended.queries).toBe(before.queries);
    expect(appended.uploadedBytes).toBe(before.uploadedBytes);
    await read(4);
    expect(pages[3].flatMap((page) => values(page, 'color'))).toEqual(
      mode === 'ids' ? [6, 5] : [5, 6],
    );
    expect(pages[3].flatMap((page) => values(page, 'static'))).toEqual(
      mode === 'ids' ? [200, 100] : [100, 200],
    );
    if (mode !== 'ids')
      expect(field(pages[3][0], 'static').binding).toEqual(field(pages[0][0], 'static').binding);
    expect(
      numbers(
        await collect(gpu.query(previous, { kind: 'rows', from: 'node', select: ['a'], at: 4 })),
        'a',
      ),
    ).toEqual([3, 4]);
    gpu.destroy();
  },
);

it('refreshes the newest sample after an append, including a duplicate coordinate, and reports the current version', async () => {
  const gpu = await createGpu({ device: fakeDevice().device });
  let source = data();
  const query = { kind: 'rows', from: 'node', select: ['a'], at: 1 } as const;
  expect(numbers(await collect(gpu.query(source, query)), 'a')).toEqual([3, 4]);
  source = appendData(source, 'v2', [samples('a', 12, [1], [7, 8])]);
  const current = await collect(gpu.query(source, query));
  expect(numbers(current, 'a')).toEqual([7, 8]);
  expect(current.every((block) => block.version === 'v2')).toBe(true);
  const reads = gpu.stats().queries;
  const later = await collect(gpu.query({ ...source, version: 'v3' }, { ...query, at: 1.5 }));
  expect(later.every((block) => block.version === 'v3')).toBe(true);
  expect(gpu.stats().queries).toBe(reads);
  gpu.destroy();
});

it('keeps empty reads, sample boundaries, rebuilt values, and invalid coordinates distinct', async () => {
  const gpu = await createGpu({ device: fakeDevice().device });
  const source = data();
  const query = { kind: 'rows', from: 'node', select: ['a'] } as const;
  expect(await collect(gpu.query(source, { ...query, at: -2 }))).toEqual([]);
  const queries = gpu.stats().queries;
  expect(await collect(gpu.query(source, { ...query, at: -1 }))).toEqual([]);
  expect(gpu.stats().queries).toBe(queries);
  expect(numbers(await collect(gpu.query(source, { ...query, at: 0 })), 'a')).toEqual([1, 2]);
  const rebuilt = createData(schema, source.version, [samples('a', 10, [0], [90, 99])]);
  expect(numbers(await collect(gpu.query(rebuilt, { ...query, at: 0 })), 'a')).toEqual([90, 99]);
  await expect(collect(gpu.query(source, { ...query, at: NaN }))).rejects.toMatchObject({
    code: 'invalid-input',
  });
  await expect(collect(gpu.query(source, query))).rejects.toMatchObject({ code: 'invalid-input' });
  gpu.destroy();
});

it('does not share field results or domains across distinct data using the same schema and row identity', async () => {
  const a = data();
  const changed = createData(schema, a.version, [samples('a', 10, [0, 1], [70, 80, 90, 99])]);
  const b = {
    ...a,
    tables: {
      node: {
        ...a.tables.node,
        fields: {
          ...a.tables.node.fields,
          a: changed.tables.node.fields.a,
        },
      },
    },
  };
  const gpu = await createGpu({ device: fakeDevice().device });
  for (const [source, expected] of [
    [a, [3, 4]],
    [b, [90, 99]],
    [a, [3, 4]],
  ] as const) {
    await gpu.render({
      timeMs: 0,
      views: [
        {
          target: target(gpu.device),
          at: 1.5,
          renderer: renderer(async (frame) => {
            for await (const native of frame.fields({
              source,
              from: 'node',
              rows: { ...rows, index },
              fields: { value: 'a' },
            })) {
              const column = native.columns.value as NumericColumn;
              expect(
                Array.from(column.values.subarray(column.offset, column.offset + column.length)),
              ).toEqual(expected);
            }
            expect(
              (await frame.scale({ source, from: 'node', rows: { ...rows, index }, field: 'a' }))
                .domain,
            ).toEqual(expected);
          }),
        },
      ],
    });
  }
  gpu.destroy();
});
