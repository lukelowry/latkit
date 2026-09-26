import type { Domain, Netlist, Part } from '@latkit/model';
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as entry from '../src/index.js';
import type { Channel, Diagram, Events, Options, Pose, Shade, ShadeFrame } from '../src/index.js';
import { twoArea } from './fixtures/netlists.js';

type Interaction = NonNullable<Options['interaction']>;

describe('diagram package entrypoint', () => {
  it('publishes exactly the controller factory, the two registries, and the option validator', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'CHANNELS',
      'OPTIONS',
      'createDiagram',
      'validateOptions',
    ]);
  });

  it('freezes both registries and every definition in them', () => {
    expect(Object.isFrozen(entry.CHANNELS)).toBe(true);
    expect(Object.isFrozen(entry.OPTIONS)).toBe(true);
    for (const definition of Object.values(entry.CHANNELS)) {
      expect(Object.isFrozen(definition)).toBe(true);
    }
    for (const definition of Object.values(entry.OPTIONS)) {
      expect(Object.isFrozen(definition)).toBe(true);
    }
    expect(Object.keys(entry.CHANNELS)).toEqual([
      'blockPosition',
      'blockColor',
      'blockVisible',
      'blockStatus',
      'blockShade',
      'portStatus',
      'netColor',
      'netFlow',
      'netVisible',
      'netShade',
    ]);
  });

  it('creates a controller without a device or a canvas, and validates options first', () => {
    const diagram = entry.createDiagram({ interaction: 'edit' });
    expect(diagram.attached).toBe(false);
    expect(diagram.painted).toBe(false);
    diagram.load(twoArea());
    expect(diagram.arrange()).toHaveLength(6);
    expect(diagram.hitTest(5, 5)).toEqual([]);
    expect(diagram.locate({ kind: 'block', index: 0 })).toBeNull();
    expect(diagram.getPose()).toBeNull();
    diagram.destroy();
    expect(() => entry.createDiagram({ gridPitch: 0 })).toThrow(RangeError);
    expect(() => entry.validateOptions({ interaction: 'draw' as Interaction })).toThrow(TypeError);
  });

  it('keeps the public types minimal and exact', () => {
    expectTypeOf<Parameters<typeof entry.createDiagram>>().toEqualTypeOf<[options?: Options]>();
    expectTypeOf<ReturnType<typeof entry.createDiagram>>().toEqualTypeOf<Diagram>();
    expectTypeOf<Parameters<Diagram['load']>>().toEqualTypeOf<
      [netlist: Netlist, options?: { readonly fit?: boolean }]
    >();
    expectTypeOf<Parameters<Diagram['setChannel']>>().toEqualTypeOf<
      [channel: Channel, values: Float32Array | Float64Array | null, domain?: Domain | null]
    >();
    expectTypeOf<ReturnType<Diagram['getChannelDomain']>>().toEqualTypeOf<Domain | null>();
    expectTypeOf<ReturnType<Diagram['arrange']>>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Parameters<Diagram['select']>>().toEqualTypeOf<[parts: readonly Part[]]>();
    expectTypeOf<ReturnType<Diagram['hitTest']>>().toEqualTypeOf<readonly Part[]>();
    expectTypeOf<ReturnType<Diagram['locate']>>().toEqualTypeOf<
      readonly [clientX: number, clientY: number] | null
    >();
    expectTypeOf<ReturnType<Diagram['toDiagram']>>().toEqualTypeOf<
      readonly [x: number, y: number] | null
    >();
    expectTypeOf<ReturnType<Diagram['getPose']>>().toEqualTypeOf<Pose | null>();
    expectTypeOf<Pose>().toEqualTypeOf<{
      readonly centerX: number;
      readonly centerY: number;
      readonly zoom: number;
    }>();
    expectTypeOf<Part>().toEqualTypeOf<{
      readonly kind: 'block' | 'port' | 'net' | 'group';
      readonly index: number;
    }>();
    expectTypeOf<Events['hover']>().toEqualTypeOf<Part | null>();
    expectTypeOf<Events['select']>().toEqualTypeOf<readonly Part[]>();
    expectTypeOf<Events['pipelineError']>().toEqualTypeOf<{ readonly cause: unknown }>();
    expectTypeOf<Events['move']>().toEqualTypeOf<{
      readonly blocks: Uint32Array;
      readonly positions: Float32Array;
    }>();
    expectTypeOf<Events['connect']['to']>().toEqualTypeOf<{
      readonly kind: 'port' | 'net';
      readonly index: number;
    } | null>();
    expectTypeOf<Parameters<Diagram['setShade']>>().toEqualTypeOf<[shade: Shade | null]>();
    expectTypeOf<ShadeFrame['pointerPx']>().toEqualTypeOf<readonly [number, number] | null>();
    expectTypeOf<Interaction>().toEqualTypeOf<'edit' | 'navigate' | 'inspect' | 'none'>();
    expectTypeOf<Options['routing']>().toEqualTypeOf<'orthogonal' | 'straight' | undefined>();
    expectTypeOf<ReturnType<Diagram['attach']>>().toEqualTypeOf<Promise<boolean>>();
    expectTypeOf<Parameters<Diagram['detach']>>().toEqualTypeOf<[canvas?: HTMLCanvasElement]>();
    expectTypeOf<Diagram['canvas']>().toEqualTypeOf<HTMLCanvasElement | null>();
    expectTypeOf<
      'ControllerDeps' extends keyof typeof entry ? true : false
    >().toEqualTypeOf<false>();
  });
});
