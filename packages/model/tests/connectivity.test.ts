import { expect, it } from 'vitest';
import {
  createData,
  read,
  numberAt,
  rowCount as axisLength,
  blockBuffers,
  validateBlock,
  validateSchema,
  type ReferenceColumn,
  type Schema,
} from '../src/index.js';
import { collect } from './fixture.js';
class Wiring {
  readonly branches = { source: 'test', type: 'Branch', version: 'branches1' };
  readonly buses = { source: 'test', type: 'Bus', version: 'buses1' };
  readonly schema: Schema = {
    types: {
      Bus: { fields: {} },
      Branch: {
        fields: {
          bus1: { type: { kind: 'reference', to: 'Bus' } },
          bus2: { type: { kind: 'reference', to: 'Bus' }, nullable: true },
        },
      },
    },
  };
  readonly data;
  constructor(
    readonly bus1 = Uint32Array.of(0, 1, 2),
    readonly bus2 = Uint32Array.of(1, 2, 0),
    readonly wired = Uint8Array.of(3),
  ) {
    const column = (values: Uint32Array): ReferenceColumn => ({
      kind: 'reference',
      index: this.buses,
      offset: 0,
      length: values.length,
      values,
    });
    this.data = createData(this.schema, 'v1', [
      {
        kind: 'rows',
        index: this.branches,
        rows: { kind: 'range', offset: 0, count: bus1.length },
        columns: { bus1: column(bus1), bus2: { ...column(bus2), validity: wired } },
      },
    ]);
  }
}
const query = { kind: 'rows', from: 'Branch', select: ['bus1', 'bus2'] } as const;

it('reads wiring as native row numbers of the referenced type, without copying', async () => {
  const source = new Wiring();
  expect(validateSchema(source.schema)).toEqual([]);
  const [block] = await collect(read(source.data, query));
  expect(validateBlock(source.schema, query, block)).toEqual([]);
  const bus1 = block.columns.bus1 as ReferenceColumn,
    bus2 = block.columns.bus2 as ReferenceColumn;
  expect(bus1.index).toEqual(source.buses);
  expect([0, 1, 2].map((i) => numberAt(bus1, i))).toEqual([0, 1, 2]);
  expect([0, 1, 2].map((i) => numberAt(bus2, i))).toEqual([1, 2, null]);
  expect(blockBuffers(block)).toContain(source.bus1.buffer);
});

it('splits a large wiring read within the block bound', async () => {
  const count = 2000;
  const source = new Wiring(
    Uint32Array.from({ length: count }, (_, i) => i),
    Uint32Array.from({ length: count }, (_, i) => (i + 1) % count),
    new Uint8Array(count / 8).fill(255),
  );
  let next = 0;
  for (const block of await collect(read(source.data, query, { maxBlockBytes: 1024 }))) {
    expect(validateBlock(source.schema, query, block, { maxBlockBytes: 1024 })).toEqual([]);
    expect(block.position).toBe(next);
    next += axisLength(block.rows);
  }
  expect(next).toBe(count);
});
