import { describe, expect, expectTypeOf, it } from 'vitest';

import { CHANNELS, OPTIONS, PROJECTIONS, validateOptions } from '../src/index.js';
import type { Channel, Options, Projection } from '../src/index.js';
import { DEFAULT_OPTIONS, resolveOptions, type ResolvedOptions } from '../src/options.js';
import { PROJECTION_DEFS } from '../src/projections.js';

describe('canonical Network semantics', () => {
  it('derives every public semantic union from its exhaustive registry', () => {
    expectTypeOf<keyof typeof CHANNELS>().toEqualTypeOf<Channel>();
    expectTypeOf<(typeof PROJECTIONS)[number]>().toEqualTypeOf<Projection>();
    expectTypeOf<keyof typeof OPTIONS>().toEqualTypeOf<keyof Required<Options>>();
    expectTypeOf<keyof ResolvedOptions>().toEqualTypeOf<keyof Options>();
    expectTypeOf<ResolvedOptions['msaa']>().toEqualTypeOf<1 | 4 | undefined>();
    expectTypeOf<(typeof OPTIONS)['msaa']['live']>().toEqualTypeOf<false>();
    expectTypeOf<(typeof OPTIONS)['vertices']['live']>().toEqualTypeOf<true>();
  });

  it('publishes the exact ordered channel vocabulary as deeply frozen metadata', () => {
    expect(Object.entries(CHANNELS)).toEqual([
      [
        'vertexColor',
        { scope: 'vertex', map: 'colormap', label: 'Vertex Color', normalized: true },
      ],
      [
        'vertexHeight',
        { scope: 'vertex', map: 'height', label: 'Vertex Height', normalized: true },
      ],
      ['vertexSize', { scope: 'vertex', map: 'size', label: 'Vertex Size', normalized: true }],
      ['edgeColor', { scope: 'edge', map: 'colormap', label: 'Edge Color', normalized: true }],
      ['edgeDash', { scope: 'edge', map: 'dash', label: 'Edge Dash', normalized: false }],
      [
        'vertexVisible',
        { scope: 'vertex', map: 'visible', label: 'Vertex Visible', normalized: false },
      ],
      ['edgeVisible', { scope: 'edge', map: 'visible', label: 'Edge Visible', normalized: false }],
    ]);
    expect(Object.isFrozen(CHANNELS)).toBe(true);
    for (const definition of Object.values(CHANNELS)) {
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it('keeps the public projection tuple and private implementation registry in parity', () => {
    expect(PROJECTIONS).toEqual(['flat', 'tilt', 'globe']);
    expect(Object.isFrozen(PROJECTIONS)).toBe(true);
    expect(Object.keys(PROJECTION_DEFS)).toEqual([...PROJECTIONS]);
    for (const mode of PROJECTIONS) expect(PROJECTION_DEFS[mode].mode).toBe(mode);
  });

  it('publishes the exact option defaults, validation kinds, and liveness', () => {
    const entries = Object.entries(OPTIONS).map(([key, definition]) => [
      key,
      definition.kind,
      definition.kind === 'colormap' ? '<colormap>' : definition.default,
      definition.live,
    ]);

    expect(entries).toEqual([
      ['msaa', 'msaa', undefined, false],
      ['vertices', 'boolean', true, true],
      ['edges', 'boolean', true, true],
      ['poles', 'boolean', false, true],
      ['vertexScale', 'nonnegative', 1, true],
      ['edgeScale', 'nonnegative', 1, true],
      ['heightScale', 'nonnegative', 1, true],
      ['heightRange', 'domain', [0, 1], true],
      ['vertexLodPx', 'nonnegative', 2, true],
      ['dashPeriodPx', 'nonnegative', 12, true],
      ['borders', 'boolean', true, true],
      ['graticule', 'boolean', false, true],
      ['earthAxis', 'boolean', true, true],
      ['daylight', 'boolean', true, true],
      ['nightFloor', 'finite', 0.55, true],
      ['surfaceNightFloor', 'finite', 0.1, true],
      ['terminatorWidth', 'nonnegative', 0.12, true],
      ['baseColor', 'rgba', [0.5, 0.5, 0.5, 1], true],
      ['colormap', 'colormap', '<colormap>', true],
      ['graticuleColor', 'rgba', [0.45, 0.48, 0.54, 1], true],
      ['surfaceColor', 'rgba', [0.15, 0.16, 0.19, 1], true],
      ['borderColor', 'rgba', [0.52, 0.5, 0.49, 1], true],
      ['focusEnabled', 'boolean', true, true],
      ['hoverColor', 'rgba', [0.72, 0.28, 0.18, 1], true],
      ['selectedColor', 'rgba', [0.72, 0.28, 0.18, 1], true],
      ['hoverAlpha', 'nonnegative', 0.5, true],
      ['selectedAlpha', 'nonnegative', 0.82, true],
      ['vertexHoverPx', 'nonnegative', 6, true],
      ['vertexSelectedPx', 'nonnegative', 7, true],
      ['edgeHoverPx', 'nonnegative', 3.5, true],
      ['edgeSelectedPx', 'nonnegative', 5, true],
      ['focusEndpointMode', 'focus-endpoint', 'selected', true],
    ]);
  });

  it('deeply freezes option metadata and defaults derived from it', () => {
    expect(Object.isFrozen(OPTIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_OPTIONS)).toBe(true);
    expect(Object.keys(DEFAULT_OPTIONS)).toEqual(Object.keys(OPTIONS));

    for (const [key, definition] of Object.entries(OPTIONS)) {
      expect(Object.isFrozen(definition), key).toBe(true);
      expect(DEFAULT_OPTIONS[key as keyof ResolvedOptions]).toBe(definition.default);
      if (
        definition.kind === 'rgba' ||
        definition.kind === 'domain' ||
        definition.kind === 'colormap'
      ) {
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
    for (const [key, definition] of Object.entries(OPTIONS)) {
      if (definition.default !== undefined) {
        expect(() => validateOptions({ [key]: definition.default }), key).not.toThrow();
      }
    }

    const cases: ReadonlyArray<readonly [keyof Options, unknown]> = [
      ['msaa', 1],
      ['msaa', 4],
      ['vertices', false],
      ['nightFloor', -3],
      ['terminatorWidth', 0],
      ['heightScale', 0],
      ['heightRange', [-1, 2]],
      ['vertexLodPx', 0],
      ['dashPeriodPx', 0],
      ['baseColor', [0, 1, 0.5, 1]],
      ['focusEndpointMode', 'off'],
      ['focusEndpointMode', 'hover-selected'],
      ['colormap', (t: number) => [t, t, t] as const],
    ];
    for (const [key, value] of cases) {
      expect(
        () => validateOptions({ [key]: value } as Options),
        `${String(key)}: ${String(value)}`,
      ).not.toThrow();
    }
  });

  it.each([
    ['vertices', 1, TypeError],
    ['nightFloor', '0.2', TypeError],
    ['nightFloor', Number.NaN, RangeError],
    ['nightFloor', Infinity, RangeError],
    ['terminatorWidth', -0.01, RangeError],
    ['vertexScale', -0.01, RangeError],
    ['edgeScale', Number.NaN, RangeError],
    ['heightScale', Infinity, RangeError],
    ['heightRange', [1], TypeError],
    ['heightRange', [2, 1], RangeError],
    ['vertexLodPx', '2', TypeError],
    ['dashPeriodPx', -1, RangeError],
    ['baseColor', [0, 0, 0], TypeError],
    ['baseColor', [0, 0, 0, '1'], TypeError],
    ['baseColor', [0, 0, 0, Number.NaN], RangeError],
    ['baseColor', [0, 0, 0, 1.01], RangeError],
    ['baseColor', new Float32Array([0, 0, 0, 1]), TypeError],
    ['focusEndpointMode', 'hover', TypeError],
    ['colormap', 'viridis', TypeError],
    ['msaa', 2, TypeError],
  ] as const)('rejects invalid %s value %s with %s', (key, value, ErrorType) => {
    expect(() => validateOptions({ [key]: value } as unknown as Options)).toThrow(ErrorType);
  });

  it('validates a complete patch before options are resolved', () => {
    expect(() => validateOptions(null as unknown as Options)).toThrow(TypeError);
    expect(() => validateOptions({ vertices: false, terminatorWidth: -1 } as Options)).toThrow(
      RangeError,
    );
  });

  it('returns a complete frozen record and owns supplied tuple values', () => {
    const baseColor: [number, number, number, number] = [0.1, 0.2, 0.3, 1];
    const heightRange: [number, number] = [0, 2];
    const colormap = (t: number) => [t, 1 - t, 0.5] as const;
    const resolved = resolveOptions({ baseColor, heightRange, colormap, msaa: 4 });

    expect(Object.keys(resolved)).toEqual(Object.keys(OPTIONS));
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.baseColor)).toBe(true);
    expect(resolved.baseColor).not.toBe(baseColor);
    expect(resolved.heightRange).not.toBe(heightRange);
    expect(resolved.colormap).toBe(colormap);
    expect(resolved.msaa).toBe(4);

    baseColor[0] = 0.9;
    heightRange[1] = 9;
    expect(resolved.baseColor).toEqual([0.1, 0.2, 0.3, 1]);
    expect(resolved.heightRange).toEqual([0, 2]);

    const defaults = resolveOptions({});
    expect(defaults).toEqual(DEFAULT_OPTIONS);
    expect(defaults.baseColor).not.toBe(DEFAULT_OPTIONS.baseColor);
    expect(Object.isFrozen(defaults.baseColor)).toBe(true);
  });
});
