import { describe, it, expect } from 'vitest';
import { COLORMAPS, colormap, gradient, type ColormapName } from '../src/index.js';

const NAMES = Object.keys(COLORMAPS) as ColormapName[];

describe('colormap catalog', () => {
  it('every name has kind + label metadata and a callable function', () => {
    for (const name of NAMES) {
      expect(COLORMAPS[name].kind, `${name} kind`).toMatch(/^(sequential|diverging)$/);
      expect(COLORMAPS[name].label, `${name} label`).toBeTruthy();
      expect(typeof colormap(name), `${name} fn`).toBe('function');
    }
  });

  it('COLORMAPS carries only the two families', () => {
    const kinds = new Set(Object.values(COLORMAPS).map((entry) => entry.kind));
    expect([...kinds].sort()).toEqual(['diverging', 'sequential']);
  });

  it('lists sequential maps before diverging maps', () => {
    const kinds = NAMES.map((name) => COLORMAPS[name].kind);
    const firstDiverging = kinds.indexOf('diverging');
    expect(firstDiverging).toBeGreaterThan(0);
    expect(kinds.slice(0, firstDiverging).every((kind) => kind === 'sequential')).toBe(true);
    expect(kinds.slice(firstDiverging).every((kind) => kind === 'diverging')).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(COLORMAPS)).toBe(true);
  });

  it('samples saturated rgb in [0,1]', () => {
    for (const name of NAMES) {
      const fn = colormap(name);
      for (const t of [-0.5, 0, 0.5, 1, 1.5]) {
        const rgb = fn(t);
        expect(rgb).toHaveLength(3);
        for (const c of rgb) {
          expect(c, `${name}@${t}`).toBeGreaterThanOrEqual(0);
          expect(c, `${name}@${t}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('viridis endpoints match the published color table (0..255 rounded)', () => {
    const fn = colormap('viridis');
    const round255 = (t: number) => fn(t).map((c) => Math.round(c * 255));
    // Viridis goes from dark purple to yellow.
    expect(round255(0)).toEqual([68, 1, 84]);
    expect(round255(1)).toEqual([253, 231, 37]);
  });
});

describe('kind', () => {
  it('is diverging for both former white- and black-center groups', () => {
    for (const name of [
      'coolwarm',
      'rdbu',
      'spectral',
      'icefire',
      'berlin',
      'rkb',
    ] as ColormapName[]) {
      expect(COLORMAPS[name].kind, name).toBe('diverging');
    }
  });

  it('is sequential for magnitude maps', () => {
    for (const name of ['viridis', 'plasma', 'grays', 'turbo'] as ColormapName[]) {
      expect(COLORMAPS[name].kind, name).toBe('sequential');
    }
  });
});

describe('black-center diverging maps', () => {
  it('icefire reads cyan -> black -> red across the range', () => {
    const css = gradient('icefire');
    expect(css).toMatch(/rgb\(0,\d+,\d+\) 0%/); // cyan: r=0
    expect(css).toMatch(/rgb\(0,0,0\) 50%/); // black at center
    expect(css).toMatch(/rgb\(\d+,\d+,0\) 100%/); // red: b=0
  });
});

describe('gradient', () => {
  it('produces a valid linear-gradient with 17 stops', () => {
    const css = gradient('viridis');
    expect(css).toMatch(/^linear-gradient\(to top,/);
    const stops = css.match(/rgb\(\d+,\d+,\d+\) \d+%/g);
    expect(stops).toHaveLength(17);
  });

  it('viridis endpoints match the published color table', () => {
    const css = gradient('viridis');
    expect(css).toMatch(/rgb\(68,1,84\) 0%/);
    expect(css).toMatch(/rgb\(253,231,37\) 100%/);
  });

  it('honors the direction parameter', () => {
    expect(gradient('viridis', 'to right')).toMatch(/^linear-gradient\(to right,/);
  });

  it('works for every preset without error', () => {
    for (const name of NAMES) {
      expect(gradient(name)).toMatch(/^linear-gradient\(to top,/);
    }
  });

  it('accepts a colormap function and clamps what it returns', () => {
    const css = gradient((t) => [t * 2, -1, Number.NaN], 'to right');
    expect(css).toMatch(/^linear-gradient\(to right,/);
    expect(css).toMatch(/rgb\(0,0,0\) 0%/);
    expect(css).toMatch(/rgb\(255,0,0\) 50%/);
    expect(css).toMatch(/rgb\(255,0,0\) 100%/);
  });
});

it('uses the published perceptual palette endpoints instead of clipped polynomial fits', () => {
  expect(colormap('viridis')(0)).toEqual([0.267004, 0.004874, 0.329415]);
  expect(colormap('viridis')(1)).toEqual([0.993248, 0.906157, 0.143936]);
  expect(colormap('inferno')(1)).toEqual([0.988362, 0.998364, 0.644924]);
  expect(colormap('plasma')(1)).toEqual([0.940015, 0.975158, 0.131326]);
  expect(colormap('magma')(1)).toEqual([0.987053, 0.991438, 0.749504]);
});
