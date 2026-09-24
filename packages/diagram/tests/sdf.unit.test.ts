import { describe, expect, it } from 'vitest';

import { random } from './fixtures/netlists.js';
import { sdf } from '../src/text/sdf.js';

/** Decode a texel to its signed distance in px, positive outside. */
function decode(value: number, radius: number): number {
  return (0.5 - value / 255) * 2 * radius;
}

/** An anti-aliased disc: coverage by 8 x 8 supersampling. */
function disc(size: number, cx: number, cy: number, r: number): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < 8; sy++) {
        for (let sx = 0; sx < 8; sx++) {
          const dx = x + (sx + 0.5) / 8 - cx;
          const dy = y + (sy + 0.5) / 8 - cy;
          if (dx * dx + dy * dy <= r * r) hits++;
        }
      }
      alpha[y * size + x] = Math.round((hits / 64) * 255);
    }
  }
  return alpha;
}

describe('sdf', () => {
  it('measures a disc to within half a pixel of its true signed distance', () => {
    const size = 64;
    const radius = 8;
    const field = sdf(disc(size, 32, 32, 16), size, size, radius);
    let worst = 0;
    let measured = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const truth = Math.hypot(x + 0.5 - 32, y + 0.5 - 32) - 16;
        if (Math.abs(truth) > radius - 1) continue;
        worst = Math.max(worst, Math.abs(decode(field[y * size + x]!, radius) - truth));
        measured++;
      }
    }
    expect(measured).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(0.75);
  });

  it('saturates beyond the radius and is monotonic along a ray', () => {
    const size = 64;
    const field = sdf(disc(size, 32, 32, 16), size, size, 4);
    expect(field[32 * size + 32]).toBe(255);
    expect(field[0]).toBe(0);
    for (let x = 33; x < size; x++) {
      expect(field[32 * size + x]!).toBeLessThanOrEqual(field[32 * size + x - 1]!);
    }
    // The edge sits between the last inside and the first outside texel.
    expect(field[32 * size + 47]!).toBeGreaterThan(127);
    expect(field[32 * size + 48]!).toBeLessThan(128);
  });

  it('matches a brute-force exact distance transform on a binary image', () => {
    const width = 23;
    const height = 17;
    const radius = 5;
    const next = random(7);
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = next() < 0.3 ? 255 : 0;
    const field = sdf(alpha, width, height, radius);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let toInside = Infinity;
        let toOutside = Infinity;
        for (let j = 0; j < height; j++) {
          for (let i = 0; i < width; i++) {
            const d = (i - x) ** 2 + (j - y) ** 2;
            if (alpha[j * width + i] === 255) toInside = Math.min(toInside, d);
            else toOutside = Math.min(toOutside, d);
          }
        }
        const d = Math.sqrt(toInside) - Math.sqrt(toOutside);
        const expected = Math.min(255, Math.max(0, Math.round(127.5 - (d * 127.5) / radius)));
        expect(field[y * width + x]).toBe(expected);
      }
    }
  });

  it('answers empty and full coverage with the saturated ends', () => {
    expect(sdf(new Uint8Array(12), 4, 3, 2).every((v) => v === 0)).toBe(true);
    expect(sdf(new Uint8Array(12).fill(255), 4, 3, 2).every((v) => v === 255)).toBe(true);
  });

  it('returns a fresh field each call while reusing its scratch', () => {
    const a = sdf(disc(16, 8, 8, 4), 16, 16, 3);
    const b = sdf(disc(40, 20, 20, 10), 40, 40, 3);
    const c = sdf(disc(16, 8, 8, 4), 16, 16, 3);
    expect(a).not.toBe(c);
    expect(c).toEqual(a);
    expect(b.length).toBe(1600);
  });

  it('rejects short coverage and a non-positive radius', () => {
    expect(() => sdf(new Uint8Array(3), 2, 2, 1)).toThrow(RangeError);
    expect(() => sdf(new Uint8Array(4), 2, 2, 0)).toThrow(/radius/);
  });
});
