import { expect, it } from 'vitest';
import type {
  Index,
  Query,
  QueryBlock,
  QueryOptions,
  ReferenceColumn,
  RowsBlock,
  Schema,
} from '../src/index.js';
import {
  blockBuffers,
  blockByteLength,
  numberAt,
  validateBlock,
  validateSchema,
} from '../src/index.js';
import { Source, axisLength, failure, selectRows, sliceRows } from './source.js';
import type { Inputs, ReadState } from './source.js';
import { collect } from './fixture.js';

interface WiringState extends ReadState {
  readonly native: {
    readonly bus1: Uint32Array;
    readonly bus2: Uint32Array;
    readonly wired: Uint8Array;
    readonly buses: Index;
  };
}

/** Branches wired to buses by two native row-number columns; bus2 is unwired where invalid. */
class Wiring extends Source {
  readonly version = '1';
  readonly branches = { source: 'native', type: 'Branch', version: 'branches:1' };
  readonly buses = { source: 'native', type: 'Bus', version: 'buses:1' };
  readonly schema: Schema = {
    queries: ['rows'],
    limits: { maxBlockBytes: 4096 },
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
  readonly inputs: Inputs;
  constructor(
    readonly bus1 = new Uint32Array([0, 1, 2]),
    readonly bus2 = new Uint32Array([1, 2, 0]),
    readonly wired = new Uint8Array([0b011]),
  ) {
    super();
    this.inputs = {
      version: this.version,
      index: this.branches,
      ids: Array.from(bus1, (_, i) => 'b' + i),
      values: new Float64Array(bus1.length),
    };
  }
  stateForRead(): WiringState {
    const backing = new Map<object, number>(
      [this.bus1, this.bus2, this.wired].map((a) => [a.buffer, a.buffer.byteLength]),
    );
    const native = { bus1: this.bus1, bus2: this.bus2, wired: this.wired, buses: this.buses };
    return { inputs: this.inputs, version: this.version, schema: this.schema, backing, native };
  }
  protected override *blocks(
    query: Query,
    state: ReadState,
    options: QueryOptions,
  ): Generator<QueryBlock> {
    if (query.kind !== 'rows' || query.from !== 'Branch') throw failure('unsupported');
    const { native } = state as WiringState;
    const rows = selectRows(state.inputs, query.rows);
    if (rows.kind !== 'range') throw failure('unsupported');
    const bound = Math.min(state.schema.limits.maxBlockBytes, options.maxBlockBytes ?? Infinity);
    for (let position = 0; position < rows.count;) {
      let count = rows.count - position;
      let block: RowsBlock;
      while (true) {
        const part = sliceRows(rows, position, position + count);
        // Views start on a bitmap byte so validity shares the values' logical offset.
        const first = rows.offset + position,
          base = first & ~7;
        const column = (field: string): ReferenceColumn => ({
          kind: 'reference',
          index: native.buses,
          values: (field === 'bus1' ? native.bus1 : native.bus2).subarray(base, first + count),
          offset: first - base,
          length: count,
          ...(field === 'bus2'
            ? { validity: native.wired.subarray(base >>> 3, (first + count + 7) >>> 3) }
            : {}),
        });
        block = {
          kind: 'rows',
          version: state.version,
          index: state.inputs.index,
          rows: part,
          position,
          columns: Object.fromEntries(query.select.map((field) => [field, column(field)])),
        };
        if (blockByteLength(block) <= bound || count === 1) break;
        count = Math.ceil(count / 2);
      }
      yield block;
      position += axisLength(block.rows);
    }
  }
}

const query = { kind: 'rows', from: 'Branch', select: ['bus1', 'bus2'] } as const;

it('reads wiring as native row numbers of the referenced type, without copying', async () => {
  const source = new Wiring();
  expect(validateSchema(source.schema)).toEqual([]);
  const [block] = await collect(source.query(query));
  expect(validateBlock(source.schema, query, block)).toEqual([]);
  const bus1 = block.columns.bus1 as ReferenceColumn,
    bus2 = block.columns.bus2 as ReferenceColumn;
  expect(bus1.index).toEqual(source.buses);
  expect([0, 1, 2].map((i) => numberAt(bus1, i))).toEqual([0, 1, 2]);
  expect([0, 1, 2].map((i) => numberAt(bus2, i))).toEqual([1, 2, null]);
  expect(blockBuffers(block)).toContain(source.bus1.buffer);
  expect(source.copiedBytes).toBe(0);
});

it('splits a large wiring read within the block bound', async () => {
  const count = 2000;
  const source = new Wiring(
    Uint32Array.from({ length: count }, (_, i) => i),
    Uint32Array.from({ length: count }, (_, i) => (i + 1) % count),
    new Uint8Array(count / 8).fill(255),
  );
  let next = 0;
  for (const block of await collect(source.query(query, { maxBlockBytes: 1024 }))) {
    expect(validateBlock(source.schema, query, block, { maxBlockBytes: 1024 })).toEqual([]);
    expect(block.position).toBe(next);
    next += axisLength(block.rows);
  }
  expect(next).toBe(count);
  expect(source.copiedBytes).toBe(0);
});

it('retains wiring independently of the source that granted it', async () => {
  const native = new Wiring(),
    source = await native.retain(),
    nested = await source.retain();
  await source.close();
  await native.close();
  const [block] = await collect(nested.query(query));
  expect(blockBuffers(block)).toContain(native.bus2.buffer);
  await nested.close();
  expect(native.retention.bytes).toBe(0);
});
