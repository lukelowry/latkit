import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createNetwork,
  finiteExtent,
  validateBorders,
  validateChannelRange,
  validateTopology,
} from '../src/index.js';
import type {
  Borders,
  ChannelRange,
  FocusEndpointMode,
  Item,
  Network,
  ProjectionMode,
  RGBA,
} from '../src/index.js';

describe('network package entrypoint', () => {
  it('re-exports the public controller factory', () => {
    expect(createNetwork).toBeTypeOf('function');
    expect(finiteExtent).toBeTypeOf('function');
    expect(validateChannelRange).toBeTypeOf('function');
    expect(validateBorders).toBeTypeOf('function');
    expect(validateTopology).toBeTypeOf('function');
    expectTypeOf<Parameters<typeof createNetwork>[1]>().toEqualTypeOf<HTMLCanvasElement>();
    expectTypeOf<Parameters<Network['setProjection']>[0]>().toEqualTypeOf<ProjectionMode>();
    expectTypeOf<Parameters<Network['rotateBy']>>().toEqualTypeOf<[dx: number, dy: number]>();
    expectTypeOf<ReturnType<Network['rotateBy']>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<typeof finiteExtent>>().toEqualTypeOf<ChannelRange | null>();
    expectTypeOf<Parameters<typeof validateBorders>[0]>().toEqualTypeOf<Borders>();
    expectTypeOf<RGBA>().toEqualTypeOf<readonly [number, number, number, number]>();
    expectTypeOf<FocusEndpointMode>().toEqualTypeOf<'off' | 'selected' | 'hover-selected'>();
    expectTypeOf<'element' extends keyof Network ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<Item>().toEqualTypeOf<{
      readonly kind: 'vertex' | 'edge';
      readonly index: number;
    }>();
    expectTypeOf<Network['locate']>().returns.toEqualTypeOf<
      readonly [clientX: number, clientY: number] | null
    >();
  });
});
