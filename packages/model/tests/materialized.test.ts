import { expect, it } from 'vitest';
import {
  appendData,
  locateSample,
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
  type DataBatch,
  type RowBatch,
  type SampleBatch,
  type RowAxis,
  validateDataEvent,
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
const batch: DataBatch = {
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
  const data = createData(schema, 'v1', [batch]);
  expect(Object.keys(data).sort()).toEqual(['schema', 'tables', 'version']);
  expect(data.tables.Node.fields.value[0].column).toBe(batch.columns.value);
  const blocks = await collect(read(data, rows));
  expect(blocks[0]).toMatchObject({ kind: 'schema', version: 'v1' });
  const block = blocks.find((b) => b.kind === 'rows')!;
  expect(blockBuffers(block)).toContain(values.buffer);
  expect(validateBlock(schema, rows, block)).toEqual([]);
});
it('selects identities, filters, sorts with stable physical ties, and counts before pagination', async () => {
  const data = createData(schema, 'v1', [batch]);
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
  const data = createData(schema, 'v1', [batch]);
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
    yield { kind: 'data', version: 'v1', block: batch };
    yield { kind: 'end', version: 'v1' };
  }
  const stream = events();
  const result = await collect(transactions(schema, stream));
  expect(result).toHaveLength(1);
  expect(await collect(stream)).toEqual([]);
  expect((await collect(read(result[0], rows))).find((b) => b.kind === 'rows')!.rows).toEqual(
    batch.rows,
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
  const data = createData(schema, 'v1', [batch]);
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
  const batches: DataBatch[] = [0, 5].map((frame) => ({
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
  const data = createData(schema, 'gaps', batches);
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
it('constructs replacement static data without mutating earlier application data', async () => {
  const previous = createData(schema, 'v1', [batch]);
  const next = createData(schema, 'v2', [
    {
      kind: 'rows',
      index,
      rows: batch.rows,
      ids: textColumn(['a', 'replacement', 'c', 'd']),
      columns: {
        value: { kind: 'numeric', offset: 0, length: 4, values: Float64Array.of(4, 99, 2, 2) },
      },
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

function observations(
  firstFrame: number,
  count = 1,
  rows: RowAxis = { kind: 'range', offset: 0, count: 2 },
): SampleBatch {
  const nr = rowCount(rows);
  return {
    kind: 'samples',
    index,
    rows,
    firstFrame,
    coordinates: Float64Array.from({ length: count }, (_, i) => firstFrame + i),
    columns: {
      output: {
        kind: 'numeric',
        offset: 0,
        length: nr * count,
        values: Float64Array.from({ length: nr * count }, (_, i) => firstFrame * 10 + i),
        rowStride: 1,
        frameStride: nr,
      },
    },
  };
}

it('rejects row appends even when a JavaScript caller bypasses the type contract', () => {
  const data = createData(schema, 'v1', [batch]);
  expect(() => appendData(data, 'v2', [batch] as unknown as SampleBatch[])).toThrow(
    /sampled observations only/,
  );
  expect(data.tables.Node.fields.value[0].column).toBe(batch.columns.value);
});

it.each([true, false, undefined])('rejects the removed replace option (%s)', (replace) => {
  const row = { ...batch, replace };
  const sample = { ...observations(0), replace };
  expect(() => createData(schema, 'v1', [row])).toThrow(/Replacement operations/);
  expect(() => appendData(createData(schema, 'empty', []), 'v1', [sample])).toThrow(
    /Replacement operations/,
  );
  for (const block of [row, sample])
    expect(validateDataEvent(schema, { kind: 'data', version: 'v1', block })).toContainEqual(
      expect.objectContaining({ message: 'Replacement operations are unsupported.' }),
    );
});

it('rejects old publication payloads rather than treating them as empty batches', () => {
  expect(
    validateDataEvent(schema, { kind: 'data', version: 'v1', patch: batch }).length,
  ).toBeGreaterThan(0);
});

it('rejects overlapping static cells and identities while allowing separate columns', () => {
  const overlap: RowBatch = {
    ...batch,
    rows: { kind: 'range', offset: 1, count: 1 },
    ids: undefined,
  };
  expect(() => createData(schema, 'v1', [batch, overlap])).toThrow(/overlap/);
  expect(() =>
    createData(schema, 'v1', [batch, { ...overlap, columns: {}, ids: textColumn(['x']) }]),
  ).toThrow(/overlap/);
  const data = createData(schema, 'v1', [
    { ...batch, ids: undefined },
    { ...batch, columns: {} },
  ]);
  expect(data.tables.Node.ids[0].column).toBe(batch.ids);
  expect(data.tables.Node.fields.value[0].column).toBe(batch.columns.value);
});

it('validates sparse row collisions without changing supplied row order', () => {
  const sparse: RowAxis = { kind: 'indices', values: Uint32Array.of(3, 1) };
  const column = { kind: 'numeric' as const, offset: 0, length: 2, values: Float64Array.of(3, 1) };
  const a: RowBatch = { kind: 'rows', index, rows: sparse, columns: { value: column } };
  const b: RowBatch = { ...a, rows: { kind: 'range', offset: 1, count: 1 } };
  expect(() => createData(schema, 'v1', [a, b])).toThrow(/overlap/);
  expect(() =>
    createData(schema, 'v1', [{ ...a, rows: { kind: 'indices', values: Uint32Array.of(1, 1) } }]),
  ).toThrow(/Duplicate/);
  const data = createData(schema, 'v1', [a]);
  expect(data.tables.Node.fields.value[0].rows).toBe(sparse);
  expect([...sparse.values]).toEqual([3, 1]);
});

it('appends row-tiled samples atomically and shares every old payload', async () => {
  const first = observations(0, 2);
  const previous = createData(schema, 'v1', [batch, first]);
  const upper = observations(2, 2, { kind: 'range', offset: 1, count: 1 });
  const lower = observations(2, 2, { kind: 'range', offset: 0, count: 1 });
  const next = appendData(previous, 'v2', [upper, lower]);
  expect(previous.tables.Node.fields.output).toHaveLength(1);
  expect(next.tables.Node.fields.output).toHaveLength(3);
  expect(next.tables.Node.fields.output[0]).toBe(previous.tables.Node.fields.output[0]);
  expect(next.tables.Node.fields.output[1].column).toBe(upper.columns.output);
  expect(next.tables.Node.fields.value).toBe(previous.tables.Node.fields.value);
  expect(next.tables.Node.ids).toBe(previous.tables.Node.ids);
  const result = await collect(
    read(next, {
      kind: 'samples',
      from: 'Node',
      select: ['output'],
      window: { kind: 'frames', offset: 0, count: 4 },
    }),
  );
  expect(
    result
      .filter((b) => b.kind === 'samples')
      .reduce((n, b) => n + rowCount(b.rows) * b.coordinates.length, 0),
  ).toBe(8);
});

it('checks a complete append before publishing, including duplicate and backfilled tiles', () => {
  const previous = createData(schema, 'v1', [observations(5)]);
  for (const incoming of [
    [observations(5)],
    [observations(2)],
    [observations(6), observations(6)],
  ]) {
    expect(() => appendData(previous, 'v2', incoming)).toThrow();
    expect(previous.tables.Node.fields.output).toHaveLength(1);
    expect(previous.version).toBe('v1');
  }
  const next = appendData(previous, 'v2', [observations(6)]);
  expect(next.tables.Node.fields.output).toHaveLength(2);
});

it('accepts new frame batches supplied out of order and then advances the append boundary', () => {
  const previous = createData(schema, 'v1', [observations(0)]);
  const next = appendData(previous, 'v2', [observations(3), observations(1)]);
  expect(() => appendData(next, 'v3', [observations(2)])).toThrow(/append after/);
  expect(appendData(next, 'v3', [observations(4)]).tables.Node.fields.output).toHaveLength(4);
});

it('rejects conflicting tile coordinates and backward coordinates, and preserves duplicates', () => {
  const a = observations(0, 2, { kind: 'range', offset: 0, count: 1 });
  const b = observations(0, 2, { kind: 'range', offset: 1, count: 1 });
  expect(() => createData(schema, 'v1', [a, { ...b, coordinates: Float64Array.of(0, 2) }])).toThrow(
    /coordinates differ/,
  );
  expect(() => createData(schema, 'v1', [{ ...a, coordinates: Float64Array.of(1, 0) }])).toThrow(
    /nondecreasing/,
  );
  const previous = createData(schema, 'v1', [a]);
  expect(() =>
    appendData(previous, 'v2', [{ ...observations(2), coordinates: Float64Array.of(0) }]),
  ).toThrow(/append after/);
  expect(
    appendData(previous, 'v2', [{ ...observations(2), coordinates: Float64Array.of(1) }]).tables
      .Node.fields.output,
  ).toHaveLength(2);
});

it('derives the append boundary for a structurally supplied Data value', () => {
  const value = createData(schema, 'v1', [observations(10)]);
  const foreign = {
    ...value,
    tables: {
      Node: { ...value.tables.Node, fields: { output: [...value.tables.Node.fields.output] } },
    },
  };
  expect(() => appendData(foreign, 'v2', [observations(9)])).toThrow(/append after/);
  expect(appendData(foreign, 'v2', [observations(11)]).tables.Node.fields.output).toHaveLength(2);
});

it('validates each aligned field against its own committed boundary', () => {
  const otherSchema: Schema = {
    ...schema,
    types: {
      Node: { fields: { ...schema.types.Node.fields, extra: { type: 'float64', sampled: true } } },
    },
  };
  const early = observations(0);
  const late = observations(5);
  const previous = createData(otherSchema, 'v1', [
    early,
    { ...late, columns: { extra: late.columns.output } },
  ]);
  const next = observations(2);
  const aligned: SampleBatch = {
    ...next,
    columns: { output: next.columns.output, extra: next.columns.output },
  };
  expect(() => appendData(previous, 'v2', [aligned])).toThrow(/append after/);
  expect(previous.tables.Node.fields.output).toHaveLength(1);
  expect(previous.tables.Node.fields.extra).toHaveLength(1);
});

it('does not reuse layout validation for differently tiled columns', () => {
  const twoFields: Schema = {
    ...schema,
    types: { Node: { fields: { ...schema.types.Node.fields, extra: { type: 'float64' } } } },
  };
  const a: RowBatch = {
    ...batch,
    ids: undefined,
    columns: { value: batch.columns.value, extra: batch.columns.value },
  };
  const b: RowBatch = {
    ...a,
    rows: { kind: 'range', offset: 1, count: 1 },
    columns: { extra: batch.columns.value },
  };
  expect(() => createData(twoFields, 'v1', [a, b])).toThrow(/overlap/);
});

it('locates the same observation as reads at duplicate coordinates and across frame gaps', async () => {
  const source = history();
  const pages = source.tables.Node.fields.output;
  for (const at of [-1, 0, 0.5, 1, 1.99, 2, 5, 6, 100]) {
    const location = locateSample(pages, at);
    const blocks = (
      await collect(
        read(source, {
          kind: 'samples',
          from: 'Node',
          select: ['output'],
          window: { kind: 'at', value: at },
        }),
      )
    ).filter((b) => b.kind === 'samples');
    if (at < 0) expect(location).toBeUndefined();
    else {
      expect(location!.frame).toBe(blocks[0].firstFrame);
      expect(location!.coordinate).toBe(blocks[0].coordinates[0]);
      expect(location!.pages[0]).toBe(pages[0]);
      expect(location!.offset).toBe(location!.frame - 2 ** 40);
    }
  }
  const grouped = createData(schema, 'gaps', [observations(0), observations(8)]);
  expect(locateSample(grouped.tables.Node.fields.output, 3)!.frame).toBe(0);
  expect(locateSample(grouped.tables.Node.fields.output, 8)!.frame).toBe(8);
  expect(locateSample([], 0)).toBeUndefined();
  expect(() => locateSample(pages, Infinity)).toThrow(/finite/);
});
