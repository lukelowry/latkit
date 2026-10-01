import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type {
  Command,
  Document,
  Edit,
  Input,
  Model,
  ModelService,
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
function publicUsage(
  model: Model,
  source: Queryable,
  document: Document,
  service: ModelService,
): void {
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
    kind: 'content',
    mediaType: 'application/octet-stream',
    stream: new ReadableStream<Uint8Array>(),
  };
  const command: Command = { routine: 'solve', values: { file: input, count: 10 } };
  void model.call?.(command, { id: 'command' });
  void service.open();
  expectTypeOf(service.recording('id')).toEqualTypeOf<Promise<Recording>>();
  expectTypeOf(source.retain({ maxBytes: 1024 })).toEqualTypeOf<Promise<Queryable>>();
  expectTypeOf(source.close()).toEqualTypeOf<Promise<void>>();
  const edits: readonly Edit[] = [
    { kind: 'add-component', type: 'Node', as: 'a', values: { position: [1, 2] } },
    {
      kind: 'add-connection',
      type: 'Relation',
      as: 'r',
      endpoints: [{ component: { local: 'a' }, port: 'a', role: 'member' }],
    },
    { kind: 'assert', id: 'existing', exists: false },
  ];
  void document.edit?.(edits);
  // @ts-expect-error Engine is not an owner in this contract.
  void model.engine;
  // @ts-expect-error Host history is outside Document.
  void document.undo;
  // @ts-expect-error No mandatory blanket version gate.
  void document.edit?.([], { ifVersion: 'old' });
  // @ts-expect-error Arbitrary implementation objects do not cross the portable input boundary.
  void service.open({ kind: 'content', arbitrary: true });
}
void publicUsage;
