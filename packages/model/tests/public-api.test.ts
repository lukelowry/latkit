import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { Data, Block } from '../src/index.js';
it('exports its values, and scopes its types under a few roots', () => {
  expect(Object.keys(api).sort()).toEqual([
    'Work',
    'appendData',
    'appendedPages',
    'assertIndex',
    'bitAt',
    'blockBuffers',
    'blockByteLength',
    'createData',
    'createMemory',
    'createReader',
    'failure',
    'fieldDefinition',
    'interruptible',
    'isFailure',
    'itemId',
    'itemKey',
    'locateSample',
    'numberAt',
    'read',
    'rowAt',
    'rowCount',
    'sameIndex',
    'samePages',
    'sampleAt',
    'sampleDomain',
    'sampleFrames',
    'sampleRuns',
    'sampledFields',
    'selectBatches',
    'selectRows',
    'sliceRows',
    'sliceSamples',
    'staticFields',
    'textAt',
    'textColumn',
    'validateBatch',
    'validateBlock',
    'validateQuery',
    'validateSchema',
    'validateSelection',
  ]);
});
function usage(data: Data) {
  expectTypeOf(api.read(data, { kind: 'rows', from: 'Node', select: ['value'] })).toEqualTypeOf<
    AsyncIterable<Block.Rows>
  >();
  expectTypeOf(
    api.read(data, {
      kind: 'samples',
      from: 'Node',
      select: ['output'],
      window: { kind: 'at', value: 0 },
    }),
  ).toEqualTypeOf<AsyncIterable<Block.Samples>>();
  // @ts-expect-error Data has no read capability or provider lifetime.
  void data.query;
  const pages = data.tables.Node.fields.output;
  expectTypeOf(pages.at(0)).toEqualTypeOf<Data.Page | undefined>();
  // @ts-expect-error Indexed columns are not mutable flat arrays.
  void pages.push;
  // @ts-expect-error Indexed page access uses at(), not an array subscript.
  void pages[0];
  // @ts-expect-error Data needs no close.
  void data.close;
}
function appendUsage(data: Data, rows: Data.RowBatch, samples: Data.SampleBatch) {
  api.createData(data.schema, [rows, samples]);
  api.appendData(data, [samples]);
  // @ts-expect-error Static rows require complete construction, never append.
  api.appendData(data, [rows]);
  // @ts-expect-error Row batches have no replacement operation.
  void rows.replace;
}
void appendUsage;
void usage;
