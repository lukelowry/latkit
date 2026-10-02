import { expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import { schema } from './fixture.js';
it('exports only the two connection entry points', () => {
  expect(Object.keys(api).sort()).toEqual(['acceptModel', 'connectLattice']);
});
function usage() {
  return api.connectLattice({
    url: 'http://localhost',
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
  });
}
void usage;
