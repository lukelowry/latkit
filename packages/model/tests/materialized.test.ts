import { expect, it } from 'vitest';
import {
  appendData,
  createData,
  read,
  textColumn,
  rowAt,
  rowCount,
  numberAt,
  sampleAt,
  validateBlock,
  blockBuffers,
  blockByteLength,
  transactions,
  type NumericColumn,
  type Schema,
  type DataPatch,
  type DataEvent,
  type SamplesQuery,
} from '../src/index.js';
const schema: Schema = {
  limits: { maxBlockBytes: 4096 },
  axis: { name: 'time' },
  types: {
    Node: {
      fields: {
        value: { type: 'float64' },
        output: { type: 'float64', sampled: true, nullable: true },
      },
    },
  },
};
const index = { source: 'test', type: 'Node', version: 'rows-1' };
const values = Float64Array.of(4, 1, 2, 2);
const patch: DataPatch = {
  kind: 'rows',
  index,
  rows: { kind: 'range', offset: 0, count: 4 },
  ids: textColumn(['a', 'b', 'c', 'd']),
  columns: { value: { kind: 'numeric', offset: 0, length: 4, values } },
};
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of stream) out.push(value);
  return out;
}
function history(nr = 2, nf = 7, bound = 4096) {
  const coordinates =
    nf === 7
      ? Float64Array.of(0, 1, 1, 2, 3, 4, 6)
      : Float64Array.from({ length: nf }, (_, i) => i);
  const values = Float64Array.from({ length: nr * nf }, (_, i) => i);
  const validity = new Uint8Array(Math.ceil(values.length / 8)).fill(255);
  return createData({ ...schema, limits: { maxBlockBytes: bound } }, 'samples', [
    {
      kind: 'samples',
      index,
      rows: { kind: 'range', offset: 0, count: nr },
      firstFrame: 2 ** 40,
      coordinates,
      columns: {
        output: {
          kind: 'numeric',
          offset: 0,
          length: values.length,
          values,
          validity,
          rowStride: 1,
          frameStride: nr,
        },
      },
    },
  ]);
}
it('data is a value with no acquisition, query or close protocol', async () => {
  const data = createData(schema, 'v1', [patch]);
  expect(Object.keys(data).sort()).toEqual(['schema', 'tables', 'version']);
  expect(data.tables.Node.fields.value[0].column).toBe(patch.columns.value);
  const blocks = await collect(read(data, rows));
  expect(blocks[0]).toMatchObject({ kind: 'schema', version: 'v1' });
  const block = blocks.find((b) => b.kind === 'rows')!;
  expect(blockBuffers(block)).toContain(values.buffer);
  expect(validateBlock(schema, rows, block)).toEqual([]);
});
it('selects identities, filters, sorts with stable physical ties, and counts before pagination', async () => {
  const data = createData(schema, 'v1', [patch]);
  const blocks = await collect(
    read(data, {
      ...rows,
      ids: true,
      where: [{ field: 'value', operator: 'greaterThan', value: 1 }],
      orderBy: [{ field: 'value', direction: 'ascending' }],
      offset: 1,
      limit: 2,
      count: true,
    }),
  );
  const block = blocks.find((b) => b.kind === 'rows')!;
  expect(block.total).toBe(3);
  expect([rowAt(block.rows, 0), rowAt(block.rows, 1)]).toEqual([3, 0]);
  const selected = await collect(read(data, { ...rows, rows: { kind: 'ids', ids: ['d', 'b'] } }));
  expect(selected.find((b) => b.kind === 'rows')!.rows).toEqual({
    kind: 'indices',
    values: Uint32Array.of(3, 1),
  });
});
it('has independent transferred copies and immutable shared pages', async () => {
  const data = createData(schema, 'v1', [patch]);
  const block = (await collect(read(data, rows, { buffers: 'owned' }))).find(
    (b) => b.kind === 'rows',
  )!;
  expect(blockBuffers(block)).not.toContain(values.buffer);
  const cloned = structuredClone(block, { transfer: [...blockBuffers(block)] as ArrayBuffer[] });
  expect(numberAt(cloned.columns.value as NumericColumn, 0)).toBe(4);
  expect(values[0]).toBe(4);
  const next = appendData(data, 'v2', []);
  expect(next.tables.Node).toBe(data.tables.Node);
  expect(data.version).toBe('v1');
});
it('keeps stored values after a producer is gone, and never replays a transaction', async () => {
  async function* events(): AsyncGenerator<DataEvent> {
    yield { kind: 'begin', version: 'v1', initial: true };
    yield { kind: 'data', version: 'v1', patch };
    yield { kind: 'end', version: 'v1' };
  }
  const stream = events();
  const result = await collect(transactions(schema, stream));
  expect(result).toHaveLength(1);
  expect(await collect(stream)).toEqual([]);
  expect((await collect(read(result[0], rows))).find((b) => b.kind === 'rows')!.rows).toEqual(
    patch.rows,
  );
  await expect(
    collect(
      transactions(
        schema,
        (async function* () {
          yield { kind: 'begin', version: 'broken', initial: false } as const;
        })(),
      ),
    ),
  ).rejects.toMatchObject({ code: 'invalid-input' });
});
it.each([
  { kind: 'at', value: -1 },
  { kind: 'at', value: 1 },
  { kind: 'range', between: [1, 1], context: { before: 1, after: 1 } },
] as const)('resolves sampled duplicates and context: %j', async (window) => {
  const data = history();
  const q: SamplesQuery = { kind: 'samples', from: 'Node', select: ['output'], window };
  const blocks = (await collect(read(data, q))).filter((b) => b.kind === 'samples');
  const coordinates = blocks.filter((b) => b.rowOffset === 0).flatMap((b) => [...b.coordinates]);
  expect(coordinates).toEqual(window.kind === 'at' ? (window.value < 0 ? [] : [1]) : [0, 1, 1, 2]);
  for (const block of blocks) expect(validateBlock(schema, q, block)).toEqual([]);
});
it('tiles every addressed sample exactly once under a tight payload bound without repacking dense backing', async () => {
  const data = history(113, 79, 2048),
    seen = new Uint8Array(113 * 79);
  const q: SamplesQuery = {
    kind: 'samples',
    from: 'Node',
    select: ['output'],
    window: { kind: 'frames', offset: 2 ** 40, count: 79 },
  };
  for await (const b of read(data, q))
    if (b.kind === 'samples') {
      expect(blockByteLength(b)).toBeLessThanOrEqual(2048);
      expect(validateBlock(data.schema, q, b)).toEqual([]);
      for (let f = 0; f < b.coordinates.length; f++)
        for (let r = 0; r < rowCount(b.rows); r++) {
          const at = (b.firstFrame + f - 2 ** 40) * 113 + rowAt(b.rows, r);
          expect(seen[at]++).toBe(0);
          expect(sampleAt(b.columns.output, { row: r, frame: f })).toBe(at);
        }
    }
  expect(seen.every((v) => v === 1)).toBe(true);
});
it('reduces samples locally and preserves exact envelope extrema and gaps', async () => {
  const data = history();
  const q = {
    kind: 'envelope',
    from: 'Node',
    select: ['output'],
    window: { kind: 'range', between: [0, 6] },
    buckets: 2,
  } as const;
  const blocks = (await collect(read(data, q))).filter((b) => b.kind === 'envelope');
  for (const b of blocks) expect(validateBlock(schema, q, b)).toEqual([]);
  expect([...blocks[0].columns.output.values.values].slice(0, 4)).toEqual([0, 0, 6, 6]);
  const aggregate = (
    await collect(
      read(data, {
        kind: 'aggregate',
        from: 'Node',
        select: ['output'],
        measures: ['min', 'max'],
        window: { kind: 'range', between: [0, 6] },
      }),
    )
  ).find((b) => b.kind === 'aggregate')!;
  expect(aggregate.values.output).toEqual({ count: 14, min: 0, max: 13 });
});
it('rejects stale identities, absent fields, impossible bounds and cancelled work', async () => {
  const data = createData(schema, 'v1', [patch]);
  await expect(
    collect(
      read(data, {
        ...rows,
        rows: { kind: 'range', offset: 0, count: 1, index: { ...index, version: 'stale' } },
      }),
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(collect(read(data, rows, { maxBlockBytes: 1 }))).rejects.toMatchObject({
    code: 'resource-limit',
  });
  await expect(collect(read(data, rows, { signal: AbortSignal.abort() }))).rejects.toMatchObject({
    code: 'aborted',
  });
});

it('resolves coordinate windows and context across gaps in stored frame numbers', async () => {
  const patches: DataPatch[] = [0, 5].map((frame) => ({
    kind: 'samples',
    index,
    rows: { kind: 'range', offset: 0, count: 1 },
    firstFrame: frame,
    coordinates: Float64Array.of(frame),
    columns: {
      output: {
        kind: 'numeric',
        offset: 0,
        length: 1,
        values: Float64Array.of(frame),
        rowStride: 1,
        frameStride: 1,
      },
    },
  }));
  const data = createData(schema, 'gaps', patches);
  const base = { kind: 'samples', from: 'Node', select: ['output'] } as const;
  const at = (await collect(read(data, { ...base, window: { kind: 'at', value: 3 } }))).filter(
    (b) => b.kind === 'samples',
  );
  expect(at.map((b) => b.firstFrame)).toEqual([0]);
  const context = (
    await collect(
      read(data, {
        ...base,
        window: { kind: 'range', between: [2, 3], context: { before: 1, after: 1 } },
      }),
    )
  ).filter((b) => b.kind === 'samples');
  expect(context.flatMap((b) => [...b.coordinates])).toEqual([0, 5]);
  await expect(
    collect(read(data, { ...base, window: { kind: 'frames', offset: 0, count: 6 } })),
  ).rejects.toMatchObject({ code: 'invalid-input' });
});
it('replaces row identities and values without mutating earlier application data', async () => {
  const previous = createData(schema, 'v1', [patch]);
  const next = appendData(previous, 'v2', [
    {
      kind: 'rows',
      index,
      rows: { kind: 'range', offset: 1, count: 1 },
      ids: textColumn(['replacement']),
      columns: { value: { kind: 'numeric', offset: 0, length: 1, values: Float64Array.of(99) } },
    },
  ]);
  const selected = (
    await collect(read(next, { ...rows, rows: { kind: 'ids', ids: ['replacement'] } }))
  ).find((b) => b.kind === 'rows')!;
  expect(numberAt(selected.columns.value as NumericColumn, 0)).toBe(99);
  const original = (
    await collect(read(previous, { ...rows, rows: { kind: 'ids', ids: ['b'] } }))
  ).find((b) => b.kind === 'rows')!;
  expect(numberAt(original.columns.value as NumericColumn, 0)).toBe(1);
  await expect(
    collect(read(next, { ...rows, rows: { kind: 'ids', ids: ['b'] } })),
  ).rejects.toMatchObject({ code: 'invalid-input' });
});
