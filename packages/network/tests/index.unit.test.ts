import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Domain, Item, Topology } from '@latkit/model';

import * as entry from '../src/index.js';
import type { Borders, Events, Network, Options, Pose, Projection } from '../src/index.js';

describe('network package entrypoint', () => {
  it('publishes exactly the controller factory, the three registries, and the option validator', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'CHANNELS',
      'OPTIONS',
      'PROJECTIONS',
      'createNetwork',
      'validateOptions',
    ]);
  });

  it('keeps the public types minimal and exact', () => {
    expectTypeOf<Parameters<typeof entry.createNetwork>>().toEqualTypeOf<[options?: Options]>();
    expectTypeOf<ReturnType<typeof entry.createNetwork>>().toEqualTypeOf<Network>();
    expectTypeOf<Parameters<Network['attach']>>().toEqualTypeOf<[canvas: HTMLCanvasElement]>();
    expectTypeOf<ReturnType<Network['attach']>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<Network['attached']>().toEqualTypeOf<boolean>();
    expectTypeOf<Parameters<Network['load']>>().toEqualTypeOf<
      [topology: Topology, options?: { readonly fit?: boolean }]
    >();
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
    expectTypeOf<Events['fit']>().toEqualTypeOf<boolean>();
    expectTypeOf<Events['attached']>().toEqualTypeOf<boolean>();
    expectTypeOf<Events['deviceLost']>().toEqualTypeOf<{
      readonly reason: string;
      readonly message: string;
      readonly recovering: boolean;
    }>();
    expectTypeOf<Events['contextmenu']>().toEqualTypeOf<{
      readonly event: MouseEvent;
      readonly keyboard: boolean;
      readonly clientX: number;
      readonly clientY: number;
      readonly items: readonly Item[];
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
    expectTypeOf<Parameters<Network['reveal']>[1]>().toEqualTypeOf<
      { readonly neighbors?: boolean; readonly animate?: boolean } | undefined
    >();
    expectTypeOf<Options['edgeBaseColor']>().toEqualTypeOf<
      readonly [number, number, number, number] | null | undefined
    >();
    expectTypeOf<Options['motion']>().toEqualTypeOf<'auto' | 'reduce' | 'full' | undefined>();
    expectTypeOf<Options['wheel']>().toEqualTypeOf<'zoom' | 'modifier' | undefined>();
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
