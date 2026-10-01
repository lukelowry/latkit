import { expect, it } from 'vitest';
import type {
  EndpointsBlock,
  LinksBlock,
  Query,
  QueryBlock,
  QueryOptions,
  Schema,
} from '../src/index.js';
import { blockBuffers, blockByteLength, validateBlock, validateSchema } from '../src/index.js';
import { Source, axisValues, compactRows, failure, selectRows } from './source.js';
import type { Inputs, ReadState } from './source.js';
import { collect } from './fixture.js';

/** Native CSR fixture. Queries derive connectivity from these arrays, not prebuilt result blocks. */
class Connectivity extends Source {
  readonly version = '1';
  readonly index = { source: 'native', type: 'Node', version: 'nodes:1' };
  readonly targetIndex = { ...this.index, type: 'Hub', version: 'hubs:1' };
  readonly connectionIndex = { ...this.index, type: 'Relation', version: 'relations:1' };
  readonly inputs: Inputs = {
    version: this.version,
    index: this.index,
    ids: ['n1', 'n2'],
    values: new Float64Array(2),
  };
  readonly schema: Schema = {
    queries: ['endpoints', 'links'],
    limits: { maxBlockBytes: 4096 },
    components: {
      Node: { fields: {}, ports: { a: { direction: 'both' }, b: { direction: 'both' } } },
      Hub: { fields: {} },
    },
    connections: { Relation: { fields: {}, roles: { node: { min: 1 }, hub: { min: 1 } } } },
  };
  constructor(
    readonly offsets = new Int32Array([0, 2, 4, 6]),
    readonly componentType = new Uint32Array([0, 1, 0, 1, 0, 1]),
    readonly componentRow = new Uint32Array([0, 2, 1, 1, 0, 3]),
    readonly port = new Uint32Array([0, 2, 0, 2, 1, 2]),
  ) {
    super();
  }
  stateForRead() {
    const native = {
      inputs: this.inputs,
      index: this.index,
      targetIndex: this.targetIndex,
      connectionIndex: this.connectionIndex,
      offsets: this.offsets,
      componentType: this.componentType,
      componentRow: this.componentRow,
      port: this.port,
    };
    const backing = new Map<object, number>(
      [this.offsets, this.componentType, this.componentRow, this.port].map((a) => [
        a.buffer,
        a.buffer.byteLength,
      ]),
    );
    return { inputs: this.inputs, version: this.version, schema: this.schema, native, backing };
  }
  protected override *blocks(
    query: Query,
    state: ReadState,
    options: QueryOptions,
  ): Generator<QueryBlock> {
    const native = (state as ReturnType<Connectivity['stateForRead']>).native;
    if (query.kind === 'endpoints') {
      const connections: Inputs = {
        ...native.inputs,
        index: native.connectionIndex,
        ids: Array.from({ length: native.offsets.length - 1 }, (_, i) => 'r' + i),
      };
      const involved = query.involving?.components.map((id) => {
        const node = native.inputs.ids.indexOf(id);
        const hub = ['h0', 'h1', 'h2', 'h3'].indexOf(id);
        if (node < 0 && hub < 0) throw failure('invalid-input');
        return { type: node < 0 ? 1 : 0, row: node < 0 ? hub : node };
      });
      for (const row of axisValues(selectRows(connections, query.rows))) {
        const start = native.offsets[row],
          end = native.offsets[row + 1];
        if (
          involved &&
          !Array.from({ length: end - start }, (_, i) => start + i).some((i) =>
            involved.some(
              (ref) => ref.type === native.componentType[i] && ref.row === native.componentRow[i],
            ),
          )
        )
          continue;
        for (let first = start; first < end;) {
          let count = Math.min(2, end - first);
          let block: EndpointsBlock;
          while (true) {
            block = {
              kind: 'endpoints',
              version: state.version,
              index: native.connectionIndex,
              connections: new Uint32Array([row]),
              offsets: new Int32Array([0, count]),
              firstEndpoint: new Uint32Array([first - start]),
              totalEndpoints: new Uint32Array([end - start]),
              componentIndexes: [native.index, native.targetIndex],
              componentType: native.componentType.subarray(first, first + count),
              componentRow: native.componentRow.subarray(first, first + count),
              portNames: ['a', 'b', null],
              port: native.port.subarray(first, first + count),
              roleNames: ['node', 'hub'],
              role: native.componentType.subarray(first, first + count),
            };
            if (
              blockByteLength(block) <=
                Math.min(options.maxBlockBytes ?? Infinity, state.schema.limits.maxBlockBytes) ||
              count === 1
            )
              break;
            count--;
          }
          yield block;
          first += count;
        }
      }
    } else if (query.kind === 'links') {
      const inputs =
        query.from === 'Node'
          ? native.inputs
          : { ...native.inputs, index: native.targetIndex, ids: ['h0', 'h1', 'h2', 'h3'] };
      const rows = selectRows(inputs, query.rows);
      for (const row of axisValues(rows)) {
        const targets = query.ports.map((port) => {
          const found: number[] = [];
          for (let connection = 0; connection < native.offsets.length - 1; connection++) {
            const start = native.offsets[connection],
              end = native.offsets[connection + 1];
            for (let i = start; i < end; i++)
              if (
                native.componentType[i] === 0 &&
                native.componentRow[i] === row &&
                native.port[i] === ['a', 'b'].indexOf(port)
              ) {
                for (let j = start; j < end; j++)
                  if (
                    j !== i &&
                    native.componentType[j] === (query.to === 'Node' ? 0 : 1) &&
                    query.role === (native.componentType[j] === 0 ? 'node' : 'hub')
                  )
                    found.push(native.componentRow[j]);
              }
          }
          if (found.length > 1) throw failure('invalid-input');
          return found[0];
        });
        const block: LinksBlock = {
          kind: 'links',
          version: state.version,
          index: native.index,
          rows: compactRows([row]),
          targetIndex: query.to === 'Node' ? native.index : native.targetIndex,
          source: new Uint32Array([targets[0] ?? 0]),
          target: new Uint32Array([targets[1] ?? 0]),
          validity: new Uint8Array([targets.every((value) => value !== undefined) ? 1 : 0]),
        };
        yield block;
      }
    } else throw failure('unsupported');
  }
}
const endpoints = { kind: 'endpoints', from: 'Relation' } as const;
const links = {
  kind: 'links',
  from: 'Node',
  ports: ['a', 'b'],
  through: 'Relation',
  role: 'hub',
  to: 'Hub',
} as const;
it('queries native relationships with stable IDs and follows links through declared roles', async () => {
  const source = new Connectivity();
  expect(validateSchema(source.schema)).toEqual([]);
  const query = { ...endpoints, involving: { components: ['n1'] } };
  const blocks = await collect(source.query(query));
  expect(blocks.flatMap((block) => [...block.connections])).toEqual([0, 2]);
  for (const block of blocks) {
    expect(validateBlock(source.schema, query, block)).toEqual([]);
    expect(blockBuffers(block)).toContain(source.componentRow.buffer);
  }
  const projection = await collect(source.query(links));
  expect([...projection[0].source, ...projection[0].target]).toEqual([2, 3]);
  expect(projection[0].validity[0]).toBe(1);
  expect(projection[1].validity[0]).toBe(0);
  for (const block of projection) expect(validateBlock(source.schema, links, block)).toEqual([]);
  expect(source.copiedBytes).toBe(0);
});
it('segments one large native relationship completely within the block bound', async () => {
  const count = 257;
  const types = Uint32Array.from({ length: count }, (_, i) => i % 2);
  const source = new Connectivity(
    new Int32Array([0, count]),
    types,
    Uint32Array.from({ length: count }, (_, i) => (i % 2 ? i % 4 : 0)),
    Uint32Array.from(types, (type) => (type === 0 ? 0 : 2)),
  );
  let next = 0;
  for (const block of await collect(source.query(endpoints, { maxBlockBytes: 1024 }))) {
    expect(validateBlock(source.schema, endpoints, block, { maxBlockBytes: 1024 })).toEqual([]);
    expect(block.firstEndpoint[0]).toBe(next);
    expect(block.totalEndpoints[0]).toBe(count);
    next += block.componentRow.length;
  }
  expect(next).toBe(count);
  expect(source.copiedBytes).toBe(0);
});
it('rejects ambiguous links instead of silently choosing a target', async () => {
  const source = new Connectivity(
    new Int32Array([0, 3]),
    new Uint32Array([0, 1, 1]),
    new Uint32Array([0, 2, 3]),
    new Uint32Array([0, 2, 2]),
  );
  await expect(collect(source.query(links))).rejects.toMatchObject({ code: 'invalid-input' });
});

it('retains native connectivity and its query implementation independently', async () => {
  const native = new Connectivity(),
    source = await native.retain(),
    nested = await source.retain();
  await source.close();
  await native.close();
  const blocks = await collect(nested.query(endpoints));
  expect(blocks.flatMap((b) => [...b.connections])).toEqual([0, 1, 2]);
  expect(blockBuffers(blocks[0])).toContain(native.componentRow.buffer);
  expect((await collect(nested.query(links)))[0].validity[0]).toBe(1);
  await nested.close();
  expect(native.retention.bytes).toBe(0);
});
