import { describe, expect, it } from 'vitest';

import { createNetwork } from '../src/index.js';

describe('network package entrypoint', () => {
  it('re-exports the public controller factory', () => {
    expect(createNetwork).toBeTypeOf('function');
  });
});
