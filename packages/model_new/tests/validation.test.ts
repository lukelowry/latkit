import { describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import type { EndpointsBlock, Query, RowsBlock, SamplesBlock, Schema } from '../src/index.js';
import {
  blockBuffers,
  blockByteLength,
  validateBlock,
  validateQuery,
  validateSchema,
} from '../src/index.js';
import { index, numbers, rows, schema, text } from './data.js';

const rowQuery = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const samplesQuery = {
  kind: 'samples',
  from: 'Node',
  select: ['output'],
  window: { kind: 'frames', offset: 10, count: 2 },
} as const;
const endpointsQuery = { kind: 'endpoints', from: 'Relation' } as const;
function endpoints(): EndpointsBlock {
  return {
    kind: 'endpoints',
    version: 'data:1',
    schemaVersion: schema.version,
    index: { ...index, type: 'Relation' },
    connections: new Uint32Array([3]),
    offsets: new Int32Array([0, 2]),
    firstEndpoint: new Uint32Array([0]),
    totalEndpoints: new Uint32Array([2]),
    componentIndexes: [index],
    componentType: new Uint32Array([0, 0]),
    componentRow: new Uint32Array([7, 9]),
    portNames: ['a', 'b'],
    port: new Uint32Array([0, 1]),
    roleNames: ['member'],
    role: new Uint32Array([0, 0]),
  };
}

describe('schema and query boundaries', () => {
  it('supports tabular, connected, nested, referenced and sampled data in one schema', () => {
    expect(validateSchema(schema)).toEqual([]);
    const queries: Query[] = [
      rowQuery,
      samplesQuery,
      endpointsQuery,
      {
        kind: 'links',
        from: 'Node',
        ports: ['a', 'b'],
        through: 'Relation',
        role: 'member',
        to: 'Node',
      },
      { kind: 'aggregate', from: 'Node', select: ['value'], measures: ['min', 'max'] },
      {
        kind: 'rows',
        from: 'Settings',
        select: ['value'],
        rows: { kind: 'range', offset: 0, count: 2 },
      },
    ];
    for (const q of queries) expect(validateQuery(schema, q)).toEqual([]);
  });
  it.each([null, [], {}, { components: null }, { queries: ['wrong'] }])(
    'reports malformed schema without throwing: %j',
    (value) => {
      expect(validateSchema(value).length).toBeGreaterThan(0);
    },
  );
  it('rejects duplicate type names, empty exclusive bounds, bad defaults, and unknown references', () => {
    const bad = {
      ...schema,
      tables: {
        Node: {
          fields: {
            broken: {
              type: 'float64',
              default: 0,
              bounds: { lower: { value: 1, inclusive: false }, upper: { value: 1 } },
            },
            ref: { type: { kind: 'reference', to: 'missing' } },
            output: { type: 'float64', sampled: true, writable: true },
          },
        },
      },
    };
    expect(validateSchema(bad).length).toBeGreaterThanOrEqual(5);
  });
  it('bounds recursive descriptions', () => {
    const type: { kind: 'list'; items?: unknown } = { kind: 'list' };
    type.items = type;
    expect(
      validateSchema({ ...schema, tables: { Recursive: { fields: { v: { type } } } } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Type nesting exceeds 32 levels.' }),
      ]),
    );
  });
  it.each([
    { ...rowQuery, rows: { kind: 'range', offset: 0xffffffff, count: 2 } },
    {
      ...rowQuery,
      rows: { kind: 'range', offset: 0, count: 1, index: { ...index, type: 'wrong' } },
    },
    { ...rowQuery, rows: { kind: 'indices', index, values: new Uint32Array([1, 1]) } },
    {
      ...rowQuery,
      rows: { kind: 'indices', index: { ...index, type: 'other' }, values: new Uint32Array([1]) },
    },
    { ...rowQuery, select: ['output'] },
    { ...rowQuery, where: [{ field: 'position', operator: 'equal', value: [0, 0] }] },
    { ...samplesQuery, window: { kind: 'range', between: [2, 1] } },
    { kind: 'aggregate', from: 'Node', select: ['value', 'output'], measures: ['min'] },
    {
      kind: 'links',
      from: 'Node',
      ports: ['a', 'a'],
      through: 'Relation',
      role: 'missing',
      to: 'Node',
    },
  ])('rejects invalid requests: %j', (query) =>
    expect(validateQuery(schema, query).length).toBeGreaterThan(0),
  );
  it('distinguishes unsupported capability from an invalid request', () => {
    expect(validateQuery({ ...schema, queries: ['rows'] }, samplesQuery)[0].code).toBe(
      'unsupported',
    );
  });
});

describe('columnar layout', () => {
  it('reads numeric slices and bit offsets without repacking', () => {
    const values = new Float64Array([99, 99, 10, 20]);
    const block: RowsBlock = {
      ...rows(),
      columns: {
        value: {
          kind: 'numeric',
          values,
          offset: 2,
          length: 2,
          validity: new Uint8Array([0b1100]),
        },
      },
    };
    expect(validateBlock(schema, rowQuery, block)).toEqual([]);
    expect(blockBuffers(block)).toContain(values.buffer);
    expect(values[2]).toBe(10);
    expect(
      validateBlock(schema, rowQuery, {
        ...block,
        columns: { value: { ...block.columns.value, validity: new Uint8Array([0b0100]) } },
      }),
    ).not.toEqual([]);
  });
  it('accepts UTF-8, packed booleans, vectors, and lists of vectors using the same row boundary', () => {
    const block: RowsBlock = {
      ...rows(),
      ids: text(['Node/1', 'Node/2']),
      columns: {
        label: text(['?', '??']),
        enabled: { kind: 'boolean', values: new Uint8Array([0b100]), offset: 1, length: 2 },
        position: { kind: 'vector', size: 2, offset: 0, length: 2, values: numbers([1, 2, 3, 4]) },
        route: {
          kind: 'list',
          offset: 0,
          length: 2,
          offsets: new Int32Array([0, 1, 3]),
          values: {
            kind: 'vector',
            size: 2,
            offset: 1,
            length: 3,
            values: numbers([99, 99, 1, 2, 3, 4, 5, 6]),
          },
        },
        parent: text(['Node/2', 'Node/1']),
      },
    };
    expect(
      validateBlock(schema, { ...rowQuery, ids: true, select: Object.keys(block.columns) }, block),
    ).toEqual([]);
  });
  it('rejects truncated offsets, invalid UTF-8, and mismatched array kinds', () => {
    for (const col of [
      { ...text(['x', 'y']), offsets: new Int32Array([0, 1]) },
      { ...text(['x', 'y']), offsets: new Int32Array([0, 2, 1]) },
      { ...text(['x', 'y']), bytes: new Uint8Array([0xff, 0xff]) },
    ])
      expect(
        validateBlock(
          schema,
          { ...rowQuery, select: ['label'] },
          { ...rows(), columns: { label: col } },
        ),
      ).not.toEqual([]);
    expect(
      validateBlock(schema, rowQuery, {
        ...rows(),
        columns: { value: { ...numbers([1, 2]), values: new Float32Array([1, 2]) } },
      }),
    ).not.toEqual([]);
  });
  it('validates rectangular sample tiles in either native orientation', () => {
    const block: SamplesBlock = {
      kind: 'samples',
      version: 'capture:1',
      schemaVersion: schema.version,
      index,
      rows: { kind: 'indices', values: new Uint32Array([7, 8, 9]) },
      rowOffset: 0,
      firstFrame: 10,
      coordinates: new Float64Array([0, 1]),
      columns: { output: { ...numbers([1, 2, 3, 4, 5, 6]), frameStride: 3, rowStride: 1 } },
    };
    expect(validateBlock(schema, samplesQuery, block)).toEqual([]);
    expect(
      validateBlock(schema, samplesQuery, {
        ...block,
        columns: { output: { ...block.columns.output, frameStride: 1, rowStride: 2 } },
      }),
    ).toEqual([]);
    expect(
      validateBlock(schema, samplesQuery, {
        ...block,
        columns: { output: { ...numbers([1, 2, 3, 4]), frameStride: 1, rowStride: 1 } },
      }),
    ).not.toEqual([]);
    expect(
      validateBlock(schema, samplesQuery, { ...block, coordinates: new Float64Array([1, 0]) }),
    ).not.toEqual([]);
  });
  it('rejects stale row selections without conflating data and index versions', () => {
    expect(
      validateBlock(
        schema,
        {
          ...rowQuery,
          rows: {
            kind: 'indices',
            index: { ...index, version: 'old' },
            values: new Uint32Array([0, 1]),
          },
        },
        rows(),
      )[0].code,
    ).toBe('conflict');
    expect(
      validateBlock(
        schema,
        { ...rowQuery, rows: { kind: 'indices', index, values: new Uint32Array([0, 1]) } },
        { ...rows(), version: 'new-input' },
      ),
    ).toEqual([]);
  });
  it('validates endpoint dictionaries, cardinality, and segments of a large connection', () => {
    expect(validateBlock(schema, endpointsQuery, endpoints())).toEqual([]);
    expect(
      validateBlock(schema, endpointsQuery, {
        ...endpoints(),
        firstEndpoint: new Uint32Array([4096]),
        totalEndpoints: new Uint32Array([8192]),
      }),
    ).toEqual([]);
    for (const bad of [
      { ...endpoints(), firstEndpoint: new Uint32Array([1]) },
      { ...endpoints(), port: new Uint32Array([0, 99]) },
      { ...endpoints(), componentIndexes: [{ ...index, document: 'different' }] },
      { ...endpoints(), roleNames: ['unknown'] },
      { ...endpoints(), portNames: [null, 'b'] },
    ])
      expect(validateBlock(schema, endpointsQuery, bad)).not.toEqual([]);
  });
  it('enforces requested aggregate measures and empty semantics', () => {
    const q: Query = { kind: 'aggregate', from: 'Node', select: ['value'], measures: ['min'] };
    const block = {
      kind: 'aggregate',
      version: '1',
      schemaVersion: schema.version,
      values: { value: { count: 0, min: null } },
    };
    expect(validateBlock(schema, q, block)).toEqual([]);
    expect(
      validateBlock(schema, q, { ...block, values: { value: { count: 0, min: 0 } } }),
    ).not.toEqual([]);
  });
});

describe('padding and input invariants', () => {
  it('ignores nested null payloads and unselected child prefixes without copying', () => {
    const block: RowsBlock = {
      ...rows(),
      columns: {
        position: {
          kind: 'vector',
          size: 2,
          offset: 1,
          length: 2,
          validity: new Uint8Array([0b100]),
          values: numbers([NaN, NaN, NaN, NaN, 3, 4]),
        },
        route: {
          kind: 'list',
          offset: 1,
          length: 2,
          validity: new Uint8Array([0b100]),
          offsets: new Int32Array([0, 1, 2, 3]),
          values: {
            kind: 'vector',
            offset: 0,
            length: 3,
            size: 2,
            values: numbers([NaN, NaN, NaN, NaN, 3, 4]),
          },
        },
      },
    };
    const query = { ...rowQuery, select: ['position', 'route'] };
    expect(validateBlock(schema, query, block)).toEqual([]);
    const bad = {
      ...block,
      columns: {
        ...block.columns,
        position: { ...block.columns.position, validity: new Uint8Array([0b110]) },
      },
    };
    expect(validateBlock(schema, query, bad)).not.toEqual([]);
  });
  it('ignores unused sample padding bits but checks addressed cells', () => {
    const block: SamplesBlock = {
      kind: 'samples',
      version: 'capture:1',
      schemaVersion: schema.version,
      index,
      rows: { kind: 'indices', values: new Uint32Array([0, 1]) },
      rowOffset: 0,
      firstFrame: 10,
      coordinates: new Float64Array([0, 1]),
      columns: {
        output: {
          ...numbers([1, 2, NaN, NaN, 3, 4]),
          frameStride: 4,
          rowStride: 1,
          validity: new Uint8Array([0b110011]),
        },
      },
    };
    expect(validateBlock(schema, samplesQuery, block)).toEqual([]);
    expect(
      validateBlock(schema, samplesQuery, {
        ...block,
        columns: { output: { ...block.columns.output, validity: new Uint8Array([0b100011]) } },
      }),
    ).not.toEqual([]);
  });
  it('rejects nonfinite inputs while preserving native sampled floating-point output', () => {
    expect(
      validateBlock(schema, rowQuery, { ...rows(), columns: { value: numbers([NaN, 1]) } }),
    ).not.toEqual([]);
    expect(
      validateBlock(
        schema,
        { ...rowQuery, select: ['output'], at: 0 },
        { ...rows(), columns: { output: numbers([NaN, 1]) } },
      ),
    ).toEqual([]);
  });
});

describe('allocation and transport boundary', () => {
  it('deduplicates shared allocation ranges and separates views from retained backing', () => {
    const backing = new ArrayBuffer(1024);
    const block = {
      ...rows(),
      columns: { value: { ...numbers([1, 2]), values: new Float64Array(backing, 16, 2) } },
    };
    expect(blockByteLength(block)).toBeLessThan(1024);
    expect(blockBuffers(block).reduce((n, b) => n + b.byteLength, 0)).toBeGreaterThanOrEqual(1024);
    expect(validateBlock(schema, rowQuery, block, { maxBlockBytes: 8 })[0].code).toBe(
      'resource-limit',
    );
    const alias = { ...block, columns: { value: block.columns.value, other: block.columns.value } };
    expect(blockByteLength(alias) - blockByteLength(block)).toBe('other'.length);
  });
  it('owned storage forbids shared backing', () => {
    const block = {
      ...rows(),
      columns: {
        value: { ...numbers([1, 2]), values: new Float64Array(new SharedArrayBuffer(16)) },
      },
    };
    expect(validateBlock(schema, rowQuery, block, { buffers: 'borrowed' })).toEqual([]);
    expect(validateBlock(schema, rowQuery, block, { buffers: 'owned' })).not.toEqual([]);
  });
  it('transfers native buffers through MessageChannel without JSON arrays or reshaping', async () => {
    const block = endpoints();
    const { port1, port2 } = new MessageChannel();
    try {
      const received = new Promise<unknown>((resolve) => port2.once('message', resolve));
      const buffers = blockBuffers(block) as ArrayBuffer[];
      port1.postMessage(block, buffers);
      expect(buffers.every((buffer) => buffer.byteLength === 0)).toBe(true);
      const result = await received;
      expect(validateBlock(schema, endpointsQuery, result, { buffers: 'owned' })).toEqual([]);
      expect((result as EndpointsBlock).componentRow).toEqual(new Uint32Array([7, 9]));
    } finally {
      port1.close();
      port2.close();
    }
  });
  it('documents that a validated block does not prove whole-stream completeness', () => {
    const q: Query = { ...rowQuery, limit: 1000 };
    const small: Schema = { ...schema, limits: { maxBlockBytes: blockByteLength(rows()) } };
    expect(validateBlock(small, q, rows())).toEqual([]);
  });
});

describe('independent sample storage and bounded validation', () => {
  it('permits each field to retain its native orientation and offset', () => {
    const extended: Schema = {
      ...schema,
      components: {
        ...schema.components,
        Node: {
          ...schema.components.Node,
          fields: { ...schema.components.Node.fields, other: { type: 'float64', sampled: true } },
        },
      },
    };
    const query = { ...samplesQuery, select: ['output', 'other'] };
    const block: SamplesBlock = {
      kind: 'samples',
      version: '1',
      schemaVersion: extended.version,
      index,
      rows: { kind: 'range', offset: 0, count: 3 },
      rowOffset: 0,
      firstFrame: 10,
      coordinates: new Float64Array([0, 1]),
      columns: {
        output: { ...numbers([1, 2, 3, 4, 5, 6]), frameStride: 3, rowStride: 1 },
        other: {
          ...numbers([99, 10, 40, 20, 50, 30, 60]),
          offset: 1,
          length: 6,
          frameStride: 1,
          rowStride: 2,
        },
      },
    };
    expect(validateBlock(extended, query, block)).toEqual([]);
    for (let frame = 0; frame < 2; frame++)
      for (let row = 0; row < 3; row++) {
        const a = block.columns.output,
          b = block.columns.other;
        expect(b.values[b.offset + frame * b.frameStride + row * b.rowStride]).toBe(
          10 * a.values[a.offset + frame * a.frameStride + row * a.rowStride],
        );
      }
  });
  it('rejects truncated huge logical slices without scanning their alleged length', () => {
    const block = {
      ...rows(),
      rows: { kind: 'range', offset: 0, count: 0x7fffffff },
      columns: { value: { ...numbers([1]), length: 0x7fffffff, validity: new Uint8Array([1]) } },
    };
    expect(validateBlock(schema, rowQuery, block)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Validity bitmap is too short.' }),
      ]),
    );
  });
  it('checks complete owned allocations even when the exposed view fits', () => {
    const values = new Float64Array(new ArrayBuffer(1024 * 1024), 0, 2);
    values.set([1, 2]);
    const block = { ...rows(), columns: { value: { ...numbers([1, 2]), values } } };
    expect(validateBlock(schema, rowQuery, block)).toEqual([]);
    expect(validateBlock(schema, rowQuery, block, { buffers: 'owned' })).toMatchObject([
      { code: 'resource-limit' },
    ]);
  });
});
