import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createMonitor,
  type Events,
  type Monitor,
  type Options,
  type Reading,
  type Series,
} from '../src/index.js';

describe('monitor package entrypoint', () => {
  it('re-exports the public controller factory and types', () => {
    expect(createMonitor).toBeTypeOf('function');
    expectTypeOf<Monitor['element']>().toEqualTypeOf<HTMLCanvasElement>();
    expectTypeOf<Options['colormap']>().toEqualTypeOf<
      ((t: number) => readonly [number, number, number]) | undefined
    >();
    expectTypeOf<Series['values']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Events['hover']>().toEqualTypeOf<Reading | null>();
  });
});
