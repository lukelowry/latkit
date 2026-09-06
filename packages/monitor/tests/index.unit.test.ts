import type { Domain, Series } from '@latkit/model';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createMonitor,
  OPTIONS,
  validateOptions,
  type Events,
  type Monitor,
  type Options,
  type Reading,
} from '../src/index.js';

describe('monitor package entrypoint', () => {
  it('re-exports the public controller factory, the option registry, and types', () => {
    expect(createMonitor).toBeTypeOf('function');
    expect(validateOptions).toBeTypeOf('function');
    expect(Object.keys(OPTIONS)).toEqual([
      'devices',
      'colormap',
      'lineWidthPx',
      'valueRange',
      'timeRange',
      'focusColor',
      'unselectedAlpha',
    ]);
    expect(Object.isFrozen(OPTIONS)).toBe(true);
    expect(OPTIONS.devices.live).toBe(false);
    expect(OPTIONS.valueRange).toMatchObject({ kind: 'domain', default: null, live: true });
    expectTypeOf<Parameters<typeof createMonitor>>().toEqualTypeOf<[options?: Options]>();
    expectTypeOf<Monitor extends { element: unknown } ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<Options['colormap']>().toEqualTypeOf<
      ((t: number) => readonly [number, number, number]) | undefined
    >();
    expectTypeOf<Options['valueRange']>().toEqualTypeOf<Domain | null | undefined>();
    expectTypeOf<Series['values']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Events['hover']>().toEqualTypeOf<Reading | null>();
    expectTypeOf<Events['select']>().toEqualTypeOf<Reading>();
    expectTypeOf<Events['attached']>().toEqualTypeOf<boolean>();
  });

  it('validates option patches completely', () => {
    expect(() => validateOptions({})).not.toThrow();
    expect(() => validateOptions({ valueRange: null, lineWidthPx: 0 })).not.toThrow();
    expect(() => validateOptions({ lineWidthPx: -1 })).toThrow(RangeError);
    expect(() => validateOptions({ lineWidthPx: '2' as never })).toThrow(TypeError);
    expect(() => validateOptions({ valueRange: [0, Number.NaN] })).toThrow(RangeError);
    expect(() => validateOptions({ valueRange: [2, 1] })).toThrow(RangeError);
    expect(() => validateOptions({ colormap: 'viridis' as never })).toThrow(TypeError);
    expect(() => validateOptions({ devices: null as never })).toThrow(TypeError);
    expect(() => validateOptions(null as never)).toThrow(TypeError);
  });
});
