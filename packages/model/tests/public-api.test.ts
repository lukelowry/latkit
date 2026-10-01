import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type {
  Command,
  CommandResult,
  Input,
  Model,
  Queryable,
  Recording,
  QueryHeader,
  RowsBlock,
  SamplesBlock,
} from '../src/index.js';

it('exports only native access and explicit boundary utilities', () => {
  expect(Object.keys(api).sort()).toEqual(
    [
      'blockBuffers',
      'blockByteLength',
      'validateBlock',
      'validateQuery',
      'validateSchema',
      'assertIndex',
      'sameIndex',
      'rowAt',
      'rowCount',
      'sliceRows',
      'bitAt',
      'numberAt',
      'textAt',
      'sampleAt',
    ].sort(),
  );
});

// Compiled usage checks; no implementation-specific subclass or generic payload is required.
function publicUsage(model: Model, source: Queryable): void {
  expectTypeOf(source.query({ kind: 'rows', from: 'Node', select: [] })).toEqualTypeOf<
    AsyncIterable<QueryHeader | RowsBlock>
  >();
  expectTypeOf(
    source.query({
      kind: 'samples',
      from: 'Node',
      select: ['output'],
      window: { kind: 'range', between: [0, 1], context: { before: 1, after: 1 } },
    }),
  ).toEqualTypeOf<AsyncIterable<QueryHeader | SamplesBlock>>();
  const input: Input = {
    mediaType: 'application/octet-stream',
    stream: new ReadableStream<Uint8Array>(),
  };
  const command: Command = { routine: 'solve', values: { file: input, count: 10 } };
  expectTypeOf(model.monitor([{ from: 'Node', select: ['output'] }])).toEqualTypeOf<
    Promise<Recording>
  >();
  expectTypeOf(model.run(command)).toEqualTypeOf<Promise<CommandResult>>();
  expectTypeOf(source.retain({ maxBytes: 1024 })).toEqualTypeOf<Promise<Queryable>>();
  expectTypeOf(source.close()).toEqualTypeOf<Promise<void>>();
  // @ts-expect-error A command is only the command: monitors choose what is streamed.
  void model.run(command, { record: [] });
  // @ts-expect-error Editing and saving belong to the model's application.
  void model.edit;
  // @ts-expect-error Commands are not correlated by id.
  void model.call;
  // @ts-expect-error Arbitrary implementation objects do not cross the portable input boundary.
  void model.run({ routine: 'solve', values: { file: { arbitrary: true } } });
}
void publicUsage;
