import { describe, it, expect } from 'vitest';
import {
  COLORMAP_KIND,
  COLORMAP_LABEL,
  COLORMAP_NAMES,
  colormap,
  colormapGradientCss,
  isDiverging,
  type ColormapName,
} from '../src/index.js';

describe('colormap catalog', () => {
  it('every name has kind + label metadata and a callable function', () => {
    for (const name of COLORMAP_NAMES) {
      expect(COLORMAP_KIND[name], `${name} kind`).toMatch(/^(sequential|diverging)$/);
      expect(COLORMAP_LABEL[name], `${name} label`).toBeTruthy();
      expect(typeof colormap(name), `${name} fn`).toBe('function');
    }
  });

  it('COLORMAP_KIND carries only the two families', () => {
    const kinds = new Set(Object.values(COLORMAP_KIND));
    expect([...kinds].sort()).toEqual(['diverging', 'sequential']);
  });

  it('samples saturated rgb in [0,1]', () => {
    for (const name of COLORMAP_NAMES) {
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

  it('viridis endpoints match the reference polynomial output (0..255 rounded)', () => {
    const fn = colormap('viridis');
    const round255 = (t: number) => fn(t).map((c) => Math.round(c * 255));
    // t=0: dark purple (71,1,85); t=1: (255,1,0).
    expect(round255(0)).toEqual([71, 1, 85]);
    expect(round255(1)).toEqual([255, 1, 0]);
  });
});

describe('isDiverging', () => {
  it('is true for diverging maps (both former white- and black-center groups)', () => {
    for (const name of [
      'coolwarm',
      'rdbu',
      'spectral',
      'icefire',
      'berlin',
      'rkb',
    ] as ColormapName[]) {
      expect(isDiverging(name), name).toBe(true);
    }
  });

  it('is false for sequential maps', () => {
    for (const name of ['viridis', 'plasma', 'grays', 'turbo'] as ColormapName[]) {
      expect(isDiverging(name), name).toBe(false);
    }
  });
});

describe('black-center diverging maps', () => {
  it('icefire reads cyan -> black -> red across the range', () => {
    const css = colormapGradientCss('icefire');
    expect(css).toMatch(/rgb\(0,\d+,\d+\) 0%/); // cyan: r=0
    expect(css).toMatch(/rgb\(0,0,0\) 50%/); // black at center
    expect(css).toMatch(/rgb\(\d+,\d+,0\) 100%/); // red: b=0
  });
});

describe('colormapGradientCss', () => {
  it('produces a valid linear-gradient with 17 stops', () => {
    const css = colormapGradientCss('viridis');
    expect(css).toMatch(/^linear-gradient\(to top,/);
    const stops = css.match(/rgb\(\d+,\d+,\d+\) \d+%/g);
    expect(stops).toHaveLength(17);
  });

  it('viridis endpoints match polynomial output', () => {
    const css = colormapGradientCss('viridis');
    expect(css).toMatch(/rgb\(71,1,85\) 0%/);
    expect(css).toMatch(/rgb\(255,1,0\) 100%/);
  });

  it('honors the direction parameter', () => {
    expect(colormapGradientCss('viridis', 'to right')).toMatch(/^linear-gradient\(to right,/);
  });

  it('works for every preset without error', () => {
    for (const name of COLORMAP_NAMES) {
      expect(colormapGradientCss(name)).toMatch(/^linear-gradient\(to top,/);
    }
  });
});
