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
  CameraPose,
  ChannelRange,
  Events,
  FocusEndpointMode,
  Item,
  Network,
  ProjectionFamily,
  PoseOptions,
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
    expectTypeOf<Parameters<Events['pipelineError']>>().toEqualTypeOf<
      [family: ProjectionFamily, cause: unknown]
    >();
    expectTypeOf<Parameters<Network['rotateBy']>>().toEqualTypeOf<[dx: number, dy: number]>();
    expectTypeOf<ReturnType<Network['rotateBy']>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<Network['getPose']>>().toEqualTypeOf<CameraPose | null>();
    expectTypeOf<Parameters<Network['setPose']>>().toEqualTypeOf<
      [pose: Partial<CameraPose>, options?: PoseOptions]
    >();
    expectTypeOf<CameraPose>().toEqualTypeOf<{
      readonly centerX: number;
      readonly centerY: number;
      readonly pitch: number;
      readonly bearing: number;
    }>();
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
