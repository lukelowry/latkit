import { expect, it } from 'vitest';
import { textColumn, type DataBatch, type Schema } from '@latkit/model';
import { preparePublication, decodePublication } from '../src/columns.js';
import { decode, prepare, Op } from '../src/frame.js';
import { defaults } from '../src/core.js';
import { batch, schema } from './fixture.js';

it('round trips native arrays, sparse rows and strided sample tiles without JSON numeric arrays', () => {
  const values = Float64Array.of(99, 1, 2, 88, 3, 4);
  const sample: DataBatch = {
    kind: 'samples',
    index: batch().index,
    rows: { kind: 'indices', values: Uint32Array.of(1, 5) },
    firstFrame: 2 ** 40,
    coordinates: Float64Array.of(0, 1),
    columns: {
      output: { kind: 'numeric', offset: 1, length: 5, values, rowStride: 1, frameStride: 3 },
    },
  };
  const plan = preparePublication(sample, 27, schema, defaults),
    sent = plan.encode(3),
    frame = decode(sent, defaults);
  expect(frame.metadata).not.toHaveProperty('values');
  const result = decodePublication({ bytes: frame.payload }, schema, defaults)[0];
  expect(result).toEqual(sample);
  const column = result.columns.output;
  if (column.kind === 'numeric') expect(column.values.buffer).toBe(sent.buffer);
  values.fill(77);
  expect(result).not.toEqual(sample);
});
it('supports every nested static column form and non-ASCII IDs', () => {
  const s: Schema = {
    types: {
      Node: {
        fields: {
          text: { type: 'text' },
          flag: { type: 'boolean' },
          vector: { type: { kind: 'vector', size: 2, items: 'float32' } },
          list: { type: { kind: 'list', items: 'int32' } },
          ref: { type: { kind: 'reference', to: 'Node' } },
        },
      },
    },
  };
  const value: DataBatch = {
    kind: 'rows',
    index: batch().index,
    rows: { kind: 'range', offset: 0, count: 2 },
    ids: textColumn(['東京', 'é']),
    columns: {
      text: textColumn(['hello', '世界']),
      flag: { kind: 'boolean', offset: 0, length: 2, values: Uint8Array.of(1) },
      vector: {
        kind: 'vector',
        offset: 0,
        length: 2,
        size: 2,
        values: { kind: 'numeric', offset: 0, length: 4, values: Float32Array.of(1, 2, 3, 4) },
      },
      list: {
        kind: 'list',
        offset: 0,
        length: 2,
        offsets: Int32Array.of(0, 1, 3),
        values: { kind: 'numeric', offset: 0, length: 3, values: Int32Array.of(1, 2, 3) },
      },
      ref: {
        kind: 'reference',
        offset: 0,
        length: 2,
        index: batch().index,
        values: Uint32Array.of(1, 0),
      },
    },
  };
  const frame = decode(preparePublication(value, 1, s, defaults).encode(1), defaults);
  expect(decodePublication({ bytes: frame.payload }, s, defaults)).toEqual([value]);
});
it('copies unaligned Buffer slices before making typed views', () => {
  const frame = preparePublication(batch(), 1, schema, defaults).encode(1);
  const storage = Buffer.alloc(frame.length + 1);
  storage.set(frame, 1);
  const decoded = decode(storage.subarray(1), defaults);
  expect(decoded.body.byteOffset % 8).toBe(0);
  expect(decodePublication({ bytes: decoded.payload }, schema, defaults)).toEqual([batch()]);
});
it('rejects truncated, future-version, oversized and aliased malicious payloads', () => {
  const encoded = preparePublication(batch(), 1, schema, defaults).encode(1);
  expect(() => decode(encoded.subarray(0, encoded.length - 1), defaults)).toThrow();
  const version = Uint8Array.from(encoded);
  version[4] = 2;
  expect(() => decode(version, defaults)).toThrow(/version/);
  expect(() => preparePublication(batch(200_000), 1, schema, defaults)).toThrow();
  const frame = decode(encoded, defaults);
  const m = frame.metadata as { batches: { columns: Record<string, unknown> }[] };
  m.batches[0].columns.output = m.batches[0].columns.value;
  const duplicate = decode(
    prepare(Op.publication, 1, m, [frame.body], defaults).encode(1),
    defaults,
  );
  expect(() => decodePublication({ bytes: duplicate.payload }, schema, defaults)).toThrow();
});
it('rejects cycles, accessors, shared storage and excessive metadata before encoding', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => prepare(Op.run, 1, cycle, [], defaults)).toThrow(/Cyclic/);
  let accessed = false;
  const getter = {
    get value() {
      accessed = true;
      return 1;
    },
  };
  expect(() => prepare(Op.run, 1, getter, [], defaults)).toThrow(/accessors/);
  expect(accessed).toBe(false);
  expect(() =>
    prepare(Op.run, 1, { long: 'x'.repeat(defaults.maxMetadataBytes) }, [], defaults),
  ).toThrow(/budget|large/);
  const value = {
    ...batch(),
    columns: {
      value: {
        kind: 'numeric' as const,
        offset: 0,
        length: 8,
        values: new Float64Array(new SharedArrayBuffer(64)),
      },
    },
  };
  expect(() => preparePublication(value, 1, schema, defaults)).toThrow(/Shared/);
});

it('rejects sparse-array allocation bombs and nonenumerable JSON hooks before invoking them', () => {
  let invoked = false;
  const hook = Object.defineProperty({}, 'toJSON', {
    value: () => {
      invoked = true;
      return 'x';
    },
  });
  expect(() => prepare(Op.run, 1, { hook }, [], defaults)).toThrow(/serialization/);
  const items = new Array(100_000_000);
  expect(() => prepare(Op.run, 1, { items }, [], defaults)).toThrow(/array limit/);
  const hidden = Object.defineProperty([], '0', {
    get: () => {
      invoked = true;
      return 1;
    },
  });
  expect(() => prepare(Op.run, 1, { hidden }, [], defaults)).toThrow(/accessors/);
  expect(invoked).toBe(false);
});
