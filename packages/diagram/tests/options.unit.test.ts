import { devices } from '@latkit/gpu';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPTIONS,
  OPTIONS,
  resolveOptions,
  validateOptions,
  type OptionDefinition,
  type Options,
} from '../src/options.js';

/** A value each kind must reject, with the error class it throws. */
const BAD: Record<OptionDefinition['kind'], readonly (readonly [unknown, ErrorConstructor])[]> = {
  boolean: [['yes', TypeError]],
  positive: [
    [0, RangeError],
    [-1, RangeError],
    [Number.NaN, RangeError],
    ['8', TypeError],
  ],
  nonnegative: [
    [-0.5, RangeError],
    [Infinity, RangeError],
    [null, TypeError],
  ],
  rgba: [
    [[2, 0, 0, 1], RangeError],
    [[0, 0, 0], TypeError],
  ],
  palette: [
    [[], TypeError],
    [Array.from({ length: 9 }, () => [0, 0, 0, 1]), TypeError],
    [
      [
        [0, 0, 0, 1],
        [0, 0, 1.5, 1],
      ],
      RangeError,
    ],
  ],
  insets: [
    [-1, RangeError],
    [[1, 2], TypeError],
    [[1, 2, 3, Number.NaN], RangeError],
  ],
  enum: [['sideways', TypeError]],
  colormap: [['vik', TypeError]],
  font: [
    ['', TypeError],
    ['   ', TypeError],
    [12, TypeError],
  ],
  pool: [[{}, TypeError]],
};

describe('OPTIONS', () => {
  it('is frozen, entry by entry', () => {
    expect(Object.isFrozen(OPTIONS)).toBe(true);
    for (const definition of Object.values(OPTIONS)) expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(OPTIONS.portColors.default)).toBe(true);
    expect(Object.isFrozen(OPTIONS.portColors.default[0])).toBe(true);
    expect(Object.isFrozen(OPTIONS.blockBaseColor.default)).toBe(true);
  });

  it('accepts only devices at construction and everything else live', () => {
    for (const [key, definition] of Object.entries(OPTIONS)) {
      expect(definition.live, key).toBe(key !== 'devices');
    }
  });

  it('suffixes only CSS-pixel options with Px; the grid pitch is in diagram units', () => {
    const px = Object.keys(OPTIONS).filter((key) => key.endsWith('Px'));
    expect(px.sort()).toEqual(['fitPaddingPx', 'pickRadiusPx', 'revealPaddingPx']);
    expect(OPTIONS.gridPitch).toEqual({ kind: 'positive', default: 8, live: true });
  });

  it('carries the documented defaults', () => {
    expect(DEFAULT_OPTIONS.devices).toBe(devices);
    expect(DEFAULT_OPTIONS.interaction).toBe('navigate');
    expect(DEFAULT_OPTIONS.gridPitch).toBe(8);
    expect(DEFAULT_OPTIONS.routing).toBe('orthogonal');
    expect(DEFAULT_OPTIONS.motion).toBe('auto');
    expect(DEFAULT_OPTIONS.animationMs).toBe(300);
    expect(DEFAULT_OPTIONS.pickRadiusPx).toBe(8);
    expect(DEFAULT_OPTIONS.fitPaddingPx).toBeNull();
    expect(DEFAULT_OPTIONS.portColors).toEqual([
      [0.45, 0.7, 0.95, 1],
      [0.93, 0.72, 0.3, 1],
    ]);
    expect(DEFAULT_OPTIONS.statusColors).toHaveLength(2);
    expect(DEFAULT_OPTIONS.colormap(0.25)).toEqual([0.25, 0.25, 0.25]);
  });
});

describe('validateOptions', () => {
  it('accepts every default and rejects a bad value of every kind', () => {
    for (const [key, definition] of Object.entries(OPTIONS)) {
      expect(() => validateOptions({ [key]: definition.default } as Options), key).not.toThrow();
      for (const [value, kind] of BAD[definition.kind]) {
        expect(
          () => validateOptions({ [key]: value } as Options),
          `${key} ${String(value)}`,
        ).toThrow(kind);
      }
    }
  });

  it('names the offending option', () => {
    expect(() => validateOptions({ gridPitch: 0 })).toThrow(
      'diagram option gridPitch must be positive',
    );
    expect(() => validateOptions({ routing: 'curved' as never })).toThrow(
      'diagram option routing must be one of orthogonal, straight',
    );
    expect(() => validateOptions({ statusColors: [[0, 0, 0, 2]] })).toThrow(
      'diagram option statusColors[0]',
    );
  });

  it('accepts insets on every side, a single inset, and null', () => {
    expect(() => validateOptions({ fitPaddingPx: [1, 2, 3, 4] })).not.toThrow();
    expect(() => validateOptions({ fitPaddingPx: 12 })).not.toThrow();
    expect(() => validateOptions({ fitPaddingPx: null })).not.toThrow();
  });

  it('rejects a record that is not an object', () => {
    expect(() => validateOptions(null as never)).toThrow('diagram options must be an object');
    expect(() => validateOptions(3 as never)).toThrow(TypeError);
  });
});

describe('resolveOptions', () => {
  it('fills defaults and freezes the record', () => {
    const resolved = resolveOptions({ gridPitch: 10 });
    expect(resolved.gridPitch).toBe(10);
    expect(resolved.snap).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(OPTIONS).sort());
  });

  it('owns caller arrays, palettes one level deep', () => {
    const outline: [number, number, number, number] = [0.1, 0.2, 0.3, 1];
    const first: [number, number, number, number] = [1, 0, 0, 1];
    const ports = [first, [0, 1, 0, 1] as const];
    const insets: [number, number, number, number] = [1, 2, 3, 4];
    const resolved = resolveOptions({
      outlineColor: outline,
      portColors: ports,
      fitPaddingPx: insets,
    });
    outline[0] = 0.9;
    first[0] = 0;
    ports.pop();
    insets[0] = 99;
    expect(resolved.outlineColor).toEqual([0.1, 0.2, 0.3, 1]);
    expect(resolved.portColors).toEqual([
      [1, 0, 0, 1],
      [0, 1, 0, 1],
    ]);
    expect(resolved.fitPaddingPx).toEqual([1, 2, 3, 4]);
    expect(Object.isFrozen(resolved.portColors)).toBe(true);
    expect(Object.isFrozen(resolved.portColors[0])).toBe(true);
    expect(Object.isFrozen(resolved.outlineColor)).toBe(true);
  });

  it('applies a patch onto a resolved base', () => {
    const base = resolveOptions({ gridPitch: 12, arrows: false });
    const next = resolveOptions({ arrows: true }, base);
    expect(next.gridPitch).toBe(12);
    expect(next.arrows).toBe(true);
    expect(base.arrows).toBe(false);
  });

  it('validates before it resolves anything', () => {
    expect(() => resolveOptions({ gridPitch: 10, labels: 'yes' as never })).toThrow(TypeError);
  });
});
