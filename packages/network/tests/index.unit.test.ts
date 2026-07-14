import { describe, expect, expectTypeOf, it } from 'vitest';

import { createNetwork } from '../src/index.js';
import type { Network } from '../src/index.js';

describe('network package entrypoint', () => {
  it('re-exports the public controller factory', () => {
    expect(createNetwork).toBeTypeOf('function');
    expectTypeOf<Parameters<typeof createNetwork>[1]>().toEqualTypeOf<HTMLCanvasElement>();
    expectTypeOf<'element' extends keyof Network ? true : false>().toEqualTypeOf<false>();
  });
});
