import { describe, expect, it } from 'vitest';

import { ceilTo, metrics, snapTo, textWidth } from '../src/geometry.js';
import { LINE } from '../src/text/metrics.js';

describe('metrics', () => {
  it('derives every size from the grid pitch', () => {
    expect(metrics(8)).toEqual({
      grid: 8,
      pitch: 16,
      titleEm: 12,
      labelEm: 10,
      groupEm: 12,
      portSize: 8,
      inset: 6,
      band: 16,
      textGap: 8,
      radius: 4,
      stub: 16,
      tagHeight: 16,
      tagGap: 4,
      tagPad: 4,
      labelGap: 4,
      groupPad: 16,
      groupHeader: 24,
    });
    expect(Object.isFrozen(metrics(8))).toBe(true);
  });

  it('keeps a band one pitch tall, room for one label line', () => {
    for (const grid of [4, 8, 10, 12]) {
      const m = metrics(grid);
      expect(m.band).toBe(m.pitch);
      expect(LINE * m.labelEm).toBeLessThanOrEqual(m.band);
    }
  });

  it('scales linearly with the pitch', () => {
    const small = metrics(4);
    const large = metrics(12);
    for (const key of Object.keys(small) as (keyof typeof small)[]) {
      expect(large[key]).toBeCloseTo(small[key] * 3, 12);
    }
  });
});

describe('sizing helpers', () => {
  it('measures text as columns times one advance', () => {
    expect(textWidth('speed', 10)).toBeCloseTo(30, 12);
    expect(textWidth('漢', 10)).toBeCloseTo(12, 12);
    expect(textWidth('', 10)).toBe(0);
  });

  it('rounds up to a quantum without gaining one from float noise', () => {
    expect(ceilTo(16 + 4e-15, 16)).toBe(16);
    expect(ceilTo(textWidth('abc', 10), 2)).toBe(18);
    expect(ceilTo(16.01, 16)).toBe(32);
    expect(ceilTo(0, 8)).toBe(0);
    expect(Object.is(ceilTo(-3, 8), 0)).toBe(true);
    expect(ceilTo(-9, 8)).toBe(-8);
  });

  it('snaps to the nearest multiple, never to -0', () => {
    expect(snapTo(13, 8)).toBe(16);
    expect(snapTo(11, 8)).toBe(8);
    expect(Object.is(snapTo(-3, 8), 0)).toBe(true);
    expect(snapTo(-13, 8)).toBe(-16);
  });
});
