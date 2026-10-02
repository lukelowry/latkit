import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type {
  RowBatch,
  SampleBatch,
  Data,
  QueryHeader,
  RowsBlock,
  SamplesBlock,
} from '../src/index.js';
it('exports values, local computation and explicit boundary validation', () => {
  for (const name of [
    'read',
    'locateSample',
    'appendedPages',
    'samplePages',
    'resolveRows',
    'createData',
    'appendData',
    'selectBatches',
    'validateBatch',
    'validateSelection',
    'validateSchema',
    'validateQuery',
    'validateBlock',
  ])
    expect(api).toHaveProperty(name);
  for (const name of ['retain', 'record', 'createRecording', 'transactions', 'validateDataEvent'])
    expect(api).not.toHaveProperty(name);
});
function usage(data: Data) {
  expectTypeOf(api.read(data, { kind: 'rows', from: 'Node', select: ['value'] })).toEqualTypeOf<
    AsyncIterable<QueryHeader | RowsBlock>
  >();
  expectTypeOf(
    api.read(data, {
      kind: 'samples',
      from: 'Node',
      select: ['output'],
      window: { kind: 'at', value: 0 },
    }),
  ).toEqualTypeOf<AsyncIterable<QueryHeader | SamplesBlock>>();
  // @ts-expect-error Data has no read capability or provider lifetime.
  void data.query;
  const pages = data.tables.Node.fields.output;
  expectTypeOf(pages.at(0)).toEqualTypeOf<api.ColumnPage | undefined>();
  // @ts-expect-error Indexed columns are not mutable flat arrays.
  void pages.push;
  // @ts-expect-error Indexed page access uses at(), not an array subscript.
  void pages[0];
  // @ts-expect-error Data needs no close.
  void data.close;
}
function appendUsage(data: Data, rows: RowBatch, samples: SampleBatch) {
  api.createData(data.schema, 'next', [rows, samples]);
  api.appendData(data, 'next', [samples]);
  // @ts-expect-error Static rows require complete construction, never append.
  api.appendData(data, 'next', [rows]);
  // @ts-expect-error Row batches have no replacement operation.
  void rows.replace;
}
void appendUsage;
void usage;
