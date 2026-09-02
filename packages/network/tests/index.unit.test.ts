import { describe, expect, expectTypeOf, it } from 'vitest';

import * as entry from '../src/index.js';
import type {
  Borders,
  Domain,
  Events,
  Item,
  Network,
  Pose,
  Projection,
  RevealOptions,
} from '../src/index.js';

describe('network package entrypoint', () => {
  it('publishes exactly the controller factory, the three registries, and two validators', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'CHANNELS',
      'OPTIONS',
      'PROJECTIONS',
      'createNetwork',
      'validateOptions',
      'validateTopology',
    ]);
  });

  it('keeps the public types minimal and exact', () => {
    expectTypeOf<Parameters<typeof entry.createNetwork>[1]>().toEqualTypeOf<HTMLCanvasElement>();
    expectTypeOf<Parameters<Network['setProjection']>>().toEqualTypeOf<
      [mode: Projection, fallback?: boolean]
    >();
    expectTypeOf<Network['geographic']>().toEqualTypeOf<boolean>();
    expectTypeOf<Events['pipelineError']>().toEqualTypeOf<{
      readonly family: 'plane' | 'globe';
      readonly cause: unknown;
    }>();
    expectTypeOf<Events['hover']>().toEqualTypeOf<Item | null>();
    expectTypeOf<Events['select']>().toEqualTypeOf<Item | null>();
    expectTypeOf<Events['deviceLost']>().toEqualTypeOf<{
      readonly reason: string;
      readonly message: string;
    }>();
    expectTypeOf<Parameters<Network['rotateBy']>>().toEqualTypeOf<[dx: number, dy: number]>();
    expectTypeOf<ReturnType<Network['getPose']>>().toEqualTypeOf<Pose | null>();
    expectTypeOf<Parameters<Network['setPose']>>().toEqualTypeOf<
      [pose: Partial<Pose>, animate?: boolean]
    >();
    expectTypeOf<Pose>().toEqualTypeOf<{
      readonly centerX: number;
      readonly centerY: number;
      readonly pitch: number;
      readonly bearing: number;
    }>();
    expectTypeOf<Parameters<Network['setChannel']>>().toEqualTypeOf<
      [channel: entry.Channel, values: Float32Array | null, domain?: Domain | null]
    >();
    expectTypeOf<ReturnType<Network['getChannelDomain']>>().toEqualTypeOf<Domain | null>();
    expectTypeOf<Parameters<Network['select']>>().toEqualTypeOf<[item: Item | null]>();
    expectTypeOf<Parameters<Network['orbit']>>().toEqualTypeOf<[active: boolean]>();
    expectTypeOf<RevealOptions['neighbors']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Parameters<typeof entry.validateTopology>[0]>().toEqualTypeOf<entry.Topology>();
    expectTypeOf<Parameters<Network['setBorders']>[0]>().toEqualTypeOf<Borders | null>();
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
