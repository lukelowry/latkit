import { expect, expectTypeOf, it } from 'vitest';
import type { Model } from '@latkit/model';
import * as api from '../src/index.js';
import type { ConnectedModel } from '../src/index.js';
import { schema } from './fixture.js';
it('exports the two connection entry points and the wire codec', () => {
  expect(Object.keys(api).sort()).toEqual(['acceptModel', 'connectModel', 'protocol']);
  expect(Object.keys(api.protocol).sort()).toEqual([
    'Op',
    'decode',
    'decodePublication',
    'prepare',
    'preparePublication',
    'subprotocols',
  ]);
  expect(api.protocol.subprotocols).toEqual({ connect: 'latkit.connect', accept: 'latkit.accept' });
});
function usage() {
  return api.connectModel(
    {
      name: 'test',
      schema,
      commands: {
        echo: { parameters: { text: { type: 'text' } }, run: ({ text }) => text },
        typed: {
          parameters: {
            text: { type: 'text' },
            n: { type: 'number' },
            b: { type: 'boolean' },
            choice: { type: 'choice', choices: ['a', 'b'] },
            files: { type: 'file', multiple: true },
            optional: { type: 'number', optional: true },
            defaulted: { type: 'number', optional: true, default: 1 },
          },
          run(args) {
            expectTypeOf(args.text).toEqualTypeOf<string>();
            expectTypeOf(args.n).toEqualTypeOf<number>();
            expectTypeOf(args.b).toEqualTypeOf<boolean>();
            expectTypeOf(args.choice).toEqualTypeOf<'a' | 'b'>();
            expectTypeOf(args.files).toEqualTypeOf<readonly File[]>();
            expectTypeOf(args.optional).toEqualTypeOf<number | undefined>();
            expectTypeOf(args.defaulted).toEqualTypeOf<number>();
            return null;
          },
        },
      },
    },
    { url: 'http://localhost' },
  );
}
function relay(accepted: ConnectedModel, socket: api.WebSocketLike) {
  // An accepted model is a Model, served onward as it is.
  expectTypeOf(accepted).toExtend<Model>();
  return api.connectModel(accepted, { socket });
}
void usage;
void relay;
