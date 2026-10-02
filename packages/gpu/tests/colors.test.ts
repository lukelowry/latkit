import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  colormaps,
  createColormap,
  reverseColormap,
  colormapCss,
  colorCss,
  parseColor,
  type RGBA,
} from '../src/index.js';
import { sampleColormap, validateRgba } from '../src/kit.js';

const black: RGBA = [0, 0, 0, 1],
  white: RGBA = [1, 1, 1, 1];
describe('color values', () => {
  it('parses CSS Color syntax without a document and preserves straight alpha', () => {
    expect(parseColor('rebeccapurple')).toEqual([0.4, 0.2, 0.6, 1]);
    expect(parseColor(' rgb(255 0 0 / 50%) ')).toEqual([1, 0, 0, 0.5]);
    expect(parseColor('hsl(120deg 100% 50%)')).toEqual([0, 1, 0, 1]);
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    for (const css of ['oklch(60% 0.2 40)', 'color(display-p3 1 0 0)', 'lab(50% 30 40)']) {
      const color = parseColor(css);
      expect(color).not.toBeNull();
      expect(() => validateRgba(color)).not.toThrow();
    }
    for (const css of ['', 'not-a-color', 'currentColor', 'var(--accent)', 'rgb(nope)'])
      expect(parseColor(css)).toBeNull();
    const value: RGBA = [0.12345, 0.8, 0.45678, 0.375];
    expect(parseColor(colorCss(value))).toEqual(value);
  });
  it('rejects nonfinite, missing and out-of-range channels', () => {
    for (const color of [
      [0, 0, 0],
      [0, 0, 0, NaN],
      [Infinity, 0, 0, 1],
      [-0.1, 0, 0, 1],
    ])
      expect(() => validateRgba(color)).toThrow();
  });
});

describe('immutable colormaps', () => {
  it('copies author data, samples once, and handles callbacks reusing a scratch color', () => {
    const scratch: [number, number, number, number] = [0, 0, 0, 1];
    const sample = vi.fn((t: number) => {
      scratch[0] = t;
      return scratch;
    });
    const map = createColormap({ sample, size: 3 });
    expect(map.colors.map((c) => c[0])).toEqual([0, 0.5, 1]);
    scratch[0] = 0.7;
    sampleColormap(map, 0.3);
    colormapCss(map);
    expect(sample).toHaveBeenCalledTimes(3);
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.colors)).toBe(true);
    expect(map.colors.every(Object.isFrozen)).toBe(true);
    const source: RGBA[] = [black, white];
    const copy = createColormap({ colors: source });
    source.reverse();
    expect(copy.colors).toEqual([black, white]);
    expect(copy.colors[0]).not.toBe(black);
  });
  it('interpolates author stops in explicit spaces, premultiplying transparency', () => {
    const stops = [
      { at: 0, color: black },
      { at: 1, color: white },
    ];
    expect(createColormap({ stops, size: 3, interpolation: 'srgb' }).colors[1][0]).toBeCloseTo(
      0.5,
      6,
    );
    expect(
      createColormap({ stops, size: 3, interpolation: 'srgb-linear' }).colors[1][0],
    ).toBeCloseTo(0.735357, 5);
    expect(createColormap({ stops, size: 3 }).colors[1][0]).toBeCloseTo(0.388573, 5);
    const transparent = createColormap({
      size: 3,
      interpolation: 'srgb',
      stops: [
        { at: 0, color: [1, 0, 0, 0] },
        { at: 1, color: [0, 0, 1, 1] },
      ],
    });
    expect(transparent.colors[1]).toEqual([0, 0, 1, 0.5]);
  });
  it('validates stops and bounded size before invoking callbacks or allocating samples', () => {
    const sample = vi.fn(() => black);
    for (const size of [0, 1, 1.5, NaN, Infinity, 16385])
      expect(() => createColormap({ sample, size })).toThrow();
    expect(sample).not.toHaveBeenCalled();
    for (const stops of [
      [],
      [
        { at: 0.5, color: black },
        { at: 1, color: white },
      ],
      [
        { at: 0, color: black },
        { at: 0, color: white },
        { at: 1, color: white },
      ],
    ])
      expect(() => createColormap({ stops })).toThrow();
    expect(() =>
      createColormap({
        kind: 'cyclic',
        stops: [
          { at: 0, color: black },
          { at: 1, color: white },
        ],
      }),
    ).toThrow(/close/);
  });
  it('samples the rendering table with clamping, premultiplied alpha and exact endpoints', () => {
    const map = createColormap({ colors: [black, white] });
    expect(sampleColormap(map, -2)).toEqual(black);
    expect(sampleColormap(map, 2)).toEqual(white);
    expect(sampleColormap(map, 0.25)).toEqual([0.25, 0.25, 0.25, 1]);
    const alpha = createColormap({
      colors: [
        [1, 0, 0, 0],
        [0, 0, 1, 1],
      ],
    });
    expect(sampleColormap(alpha, 0.5)).toEqual([0, 0, 1, 0.5]);
    expect(sampleColormap(alpha, 0)).toEqual([0, 0, 0, 0]);
    for (const t of [NaN, Infinity, -Infinity]) expect(() => sampleColormap(map, t)).toThrow();
  });
  it('wraps cyclic samples, closes their seam and preserves phase when reversed', () => {
    const map = createColormap({
      kind: 'cyclic',
      colors: [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0, 1, 1],
      ],
    });
    expect(sampleColormap(map, 0)).toEqual(sampleColormap(map, 1));
    expect(sampleColormap(map, -0.25)).toEqual(sampleColormap(map, 0.75));
    expect(sampleColormap(map, 5 / 6)).toEqual([0.5, 0, 0.5, 1]);
    expect(reverseColormap(map).colors[0]).toBe(map.colors[0]);
    expect(sampleColormap(reverseColormap(map), 0.25)).toEqual(sampleColormap(map, -0.25));
    expect(reverseColormap(reverseColormap(map))).toBe(map);
    expect(reverseColormap(map)).toBe(reverseColormap(map));
  });
  it('never interpolates categories and includes every hard boundary in CSS', () => {
    const map = createColormap({ kind: 'categorical', colors: [black, white] });
    expect(sampleColormap(map, 0.49)).toEqual(black);
    expect(sampleColormap(map, 0.5)).toEqual(white);
    expect(sampleColormap(map, 1)).toEqual(white);
    expect(colormapCss(map)).toContain('0% 50%');
    expect(colormapCss(map)).toContain('50% 100%');
    const single = createColormap({ kind: 'categorical', colors: [white] });
    expect(sampleColormap(single, 0.5)).toEqual(white);
  });
});

it('preserves every published catalog sample and source checksum', () => {
  const provenance = JSON.parse(
    readFileSync(new URL('../src/colors/presets/provenance.json', import.meta.url), 'utf8'),
  ) as {
    palettes: Record<string, { count: number; sha256: string }>;
  };
  expect(Object.keys(colormaps)).toHaveLength(46);
  expect(Object.isFrozen(colormaps)).toBe(true);
  for (const [name, map] of Object.entries(colormaps)) {
    const record = provenance.palettes[name];
    expect(record, name).toBeDefined();
    expect(map.colors.length, name).toBe(record.count);
    const bytes = Buffer.alloc(map.colors.length * 24);
    map.colors.forEach((color, i) => {
      validateRgba(color);
      for (let c = 0; c < 3; c++) bytes.writeDoubleLE(color[c], i * 24 + c * 8);
    });
    expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(record.sha256);
    expect(map.colors).toBe(map.colors);
    expect(Object.isFrozen(map.colors)).toBe(true);
  }
  expect(colormaps.viridis.colors[0]).toEqual([0.267004, 0.004874, 0.329415, 1]);
});
