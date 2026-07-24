import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CHANNEL_DEFINITIONS,
  DEFAULT_OPTIONS,
  OPTION_DEFINITIONS,
  PROJECTION_MODES,
  validateOption,
  validateOptions,
} from '../src/index.js';
import type {
  Channel,
  ChannelDefinition,
  ChannelMap,
  ChannelScope,
  ConstructionOption,
  OptionDefinition,
  Options,
  ProjectionMode,
  ResolvedOptions,
  RuntimeOption,
} from '../src/index.js';
import { resolveOptions } from '../src/options.js';
import { PROJECTIONS } from '../src/projections.js';

describe('canonical Network semantics', () => {
  it('derives every public semantic union from its exhaustive registry', () => {
    expectTypeOf<(typeof CHANNEL_DEFINITIONS)[number]>().toEqualTypeOf<ChannelDefinition>();
    expectTypeOf<(typeof CHANNEL_DEFINITIONS)[number]['key']>().toEqualTypeOf<Channel>();
    expectTypeOf<(typeof CHANNEL_DEFINITIONS)[number]['scope']>().toEqualTypeOf<ChannelScope>();
    expectTypeOf<(typeof CHANNEL_DEFINITIONS)[number]['map']>().toEqualTypeOf<ChannelMap>();
    expectTypeOf<(typeof PROJECTION_MODES)[number]>().toEqualTypeOf<ProjectionMode>();
    expectTypeOf<keyof typeof OPTION_DEFINITIONS>().toEqualTypeOf<keyof Required<Options>>();
    expectTypeOf<
      (typeof OPTION_DEFINITIONS)[keyof typeof OPTION_DEFINITIONS]
    >().toMatchTypeOf<OptionDefinition>();
    expectTypeOf<keyof ResolvedOptions>().toEqualTypeOf<keyof Options>();
    expectTypeOf<ResolvedOptions['msaa']>().toEqualTypeOf<1 | 4 | undefined>();
    expectTypeOf<ConstructionOption>().toEqualTypeOf<'msaa'>();
    expectTypeOf<RuntimeOption>().toEqualTypeOf<Exclude<keyof Options, 'msaa'>>();
  });

  it('publishes the exact ordered channel vocabulary as deeply frozen metadata', () => {
    expect(CHANNEL_DEFINITIONS).toEqual([
      { key: 'vertexColor', scope: 'vertex', map: 'colormap' },
      { key: 'vertexHeight', scope: 'vertex', map: 'height' },
      { key: 'vertexSize', scope: 'vertex', map: 'size' },
      { key: 'edgeColor', scope: 'edge', map: 'colormap' },
      { key: 'edgeDash', scope: 'edge', map: 'dash' },
    ]);
    expect(Object.isFrozen(CHANNEL_DEFINITIONS)).toBe(true);
    for (const definition of CHANNEL_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it('keeps the public projection tuple and private implementation registry in parity', () => {
    expect(PROJECTION_MODES).toEqual(['flat', 'tilt', 'globe']);
    expect(Object.isFrozen(PROJECTION_MODES)).toBe(true);
    expect(Object.keys(PROJECTIONS)).toEqual([...PROJECTION_MODES]);
    for (const mode of PROJECTION_MODES) expect(PROJECTIONS[mode].mode).toBe(mode);
  });

  it('publishes the exact option defaults, validation kinds, and lifecycles', () => {
    const entries = Object.entries(OPTION_DEFINITIONS).map(([key, definition]) => [
      key,
      definition.kind,
      definition.kind === 'colormap' ? '<colormap>' : definition.default,
      definition.lifecycle,
    ]);

    expect(entries).toEqual([
      ['msaa', 'msaa', undefined, 'construction'],
      ['vertices', 'boolean', true, 'runtime'],
      ['edges', 'boolean', true, 'runtime'],
      ['poles', 'boolean', false, 'runtime'],
      ['borders', 'boolean', true, 'runtime'],
      ['graticule', 'boolean', false, 'runtime'],
      ['earthAxis', 'boolean', true, 'runtime'],
      ['daylight', 'boolean', true, 'runtime'],
      ['nightFloor', 'finite', 0.55, 'runtime'],
      ['surfaceNightFloor', 'finite', 0.1, 'runtime'],
      ['terminatorWidth', 'nonnegative', 0.12, 'runtime'],
      ['baseColor', 'rgba', [0.5, 0.5, 0.5, 1], 'runtime'],
      ['colormap', 'colormap', '<colormap>', 'runtime'],
      ['graticuleColor', 'rgba', [0.45, 0.48, 0.54, 1], 'runtime'],
      ['surfaceColor', 'rgba', [0.15, 0.16, 0.19, 1], 'runtime'],
      ['borderColor', 'rgba', [0.52, 0.5, 0.49, 1], 'runtime'],
      ['focusEnabled', 'boolean', true, 'runtime'],
      ['hoverColor', 'rgba', [0.72, 0.28, 0.18, 1], 'runtime'],
      ['selectedColor', 'rgba', [0.72, 0.28, 0.18, 1], 'runtime'],
      ['hoverAlpha', 'nonnegative', 0.5, 'runtime'],
      ['selectedAlpha', 'nonnegative', 0.82, 'runtime'],
      ['vertexHoverPx', 'nonnegative', 6, 'runtime'],
      ['vertexSelectedPx', 'nonnegative', 7, 'runtime'],
      ['edgeHoverPx', 'nonnegative', 3.5, 'runtime'],
      ['edgeSelectedPx', 'nonnegative', 5, 'runtime'],
      ['focusEndpointMode', 'focus-endpoint', 'selected', 'runtime'],
    ]);
  });

  it('deeply freezes option metadata and defaults derived from it', () => {
    expect(Object.isFrozen(OPTION_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_OPTIONS)).toBe(true);
    expect(Object.keys(DEFAULT_OPTIONS)).toEqual(Object.keys(OPTION_DEFINITIONS));

    for (const [key, definition] of Object.entries(OPTION_DEFINITIONS)) {
      expect(Object.isFrozen(definition), key).toBe(true);
      expect(DEFAULT_OPTIONS[key as keyof ResolvedOptions]).toBe(definition.default);
      if (definition.kind === 'rgba' || definition.kind === 'colormap') {
        expect(Object.isFrozen(definition.default), key).toBe(true);
      }
    }

    expect(DEFAULT_OPTIONS.colormap(0)).toEqual([0, 0, 0]);
    expect(DEFAULT_OPTIONS.colormap(0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(DEFAULT_OPTIONS.colormap(1)).toEqual([1, 1, 1]);
  });
});

describe('Network option validation and resolution', () => {
  it('accepts every canonical default and representative boundary values', () => {
    for (const [key, definition] of Object.entries(OPTION_DEFINITIONS)) {
      if (definition.default !== undefined) {
        expect(() => validateOption(key as keyof Options, definition.default), key).not.toThrow();
      }
    }

    const cases: ReadonlyArray<readonly [keyof Options, unknown]> = [
      ['msaa', 1],
      ['msaa', 4],
      ['vertices', false],
      ['nightFloor', -3],
      ['terminatorWidth', 0],
      ['baseColor', [0, 1, 0.5, 1]],
      ['focusEndpointMode', 'off'],
      ['focusEndpointMode', 'hover-selected'],
      ['colormap', (t: number) => [t, t, t] as const],
    ];
    for (const [key, value] of cases) {
      expect(() => validateOption(key, value), `${String(key)}: ${String(value)}`).not.toThrow();
    }
  });

  it.each([
    ['vertices', 1, TypeError],
    ['nightFloor', '0.2', TypeError],
    ['nightFloor', Number.NaN, RangeError],
    ['nightFloor', Infinity, RangeError],
    ['terminatorWidth', -0.01, RangeError],
    ['baseColor', [0, 0, 0], TypeError],
    ['baseColor', [0, 0, 0, '1'], TypeError],
    ['baseColor', [0, 0, 0, Number.NaN], RangeError],
    ['baseColor', [0, 0, 0, 1.01], RangeError],
    ['baseColor', new Float32Array([0, 0, 0, 1]), TypeError],
    ['focusEndpointMode', 'hover', TypeError],
    ['colormap', 'viridis', TypeError],
    ['msaa', 2, TypeError],
  ] as const)('rejects invalid %s value %s with %s', (key, value, ErrorType) => {
    expect(() => validateOption(key, value)).toThrow(ErrorType);
  });

  it('validates a complete patch before options are resolved', () => {
    expect(() => validateOptions(null as unknown as Options)).toThrow(TypeError);
    expect(() => validateOptions({ vertices: false, terminatorWidth: -1 } as Options)).toThrow(
      RangeError,
    );
  });

  it('returns a complete frozen record and owns supplied tuple values', () => {
    const baseColor: [number, number, number, number] = [0.1, 0.2, 0.3, 1];
    const colormap = (t: number) => [t, 1 - t, 0.5] as const;
    const resolved = resolveOptions({ baseColor, colormap, msaa: 4 });

    expect(Object.keys(resolved)).toEqual(Object.keys(OPTION_DEFINITIONS));
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.baseColor)).toBe(true);
    expect(resolved.baseColor).not.toBe(baseColor);
    expect(resolved.colormap).toBe(colormap);
    expect(resolved.msaa).toBe(4);

    baseColor[0] = 0.9;
    expect(resolved.baseColor).toEqual([0.1, 0.2, 0.3, 1]);

    const defaults = resolveOptions({});
    expect(defaults).toEqual(DEFAULT_OPTIONS);
    expect(defaults.baseColor).not.toBe(DEFAULT_OPTIONS.baseColor);
    expect(Object.isFrozen(defaults.baseColor)).toBe(true);
  });
});
