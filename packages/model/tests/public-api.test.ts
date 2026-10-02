import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type {
  RowBatch,
  SampleBatch,
  Model,
  Commands,
  Data,
  DataEvent,
  QueryHeader,
  RowsBlock,
  SamplesBlock,
  CommandResult,
} from '../src/index.js';
it('exports values, local computation and explicit boundary validation', () => {
  for (const name of [
    'read',
    'createData',
    'appendData',
    'transactions',
    'validateDataEvent',
    'validateSchema',
    'validateQuery',
    'validateBlock',
  ])
    expect(api).toHaveProperty(name);
  for (const name of ['retain', 'record', 'createRecording']) expect(api).not.toHaveProperty(name);
});
function usage(model: Model, commands: Commands, data: Data) {
  expectTypeOf(model.monitor([{ from: 'Node', select: ['output'] }])).toEqualTypeOf<
    AsyncIterable<DataEvent>
  >();
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
  expectTypeOf(commands.run({ routine: 'solve', values: {} })).toEqualTypeOf<
    Promise<CommandResult>
  >();
  // @ts-expect-error Models do not run commands.
  void model.run;
  // @ts-expect-error Models do not retain or replay values.
  void model.retain;
  // @ts-expect-error Data has no read capability or provider lifetime.
  void data.query;
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
