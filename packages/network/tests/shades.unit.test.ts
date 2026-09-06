import { describe, expect, it } from 'vitest';

import * as entry from '../src/shades/index.js';
import { spotlight } from '../src/shades/index.js';
import { POINTER_NONE, SHADE_HOST_WORDS, type ShadeFrame } from '../src/shade.js';

const viewport = { w: 800, h: 600 };

function frame(timeMs: number, pointerPx: readonly [number, number] | null): ShadeFrame {
  return { timeMs, pointerPx, viewport };
}

describe('shades entrypoint', () => {
  it('publishes exactly the presets', () => {
    expect(Object.keys(entry).sort()).toEqual(['spotlight']);
  });
});

describe('spotlight', () => {
  it('declares the shade hook and validates its options', () => {
    expect(spotlight().wgsl).toContain('fn shade(f: Fragment) -> vec4f');
    expect(() => spotlight({ radiusPx: -1 })).toThrow(RangeError);
    expect(() => spotlight({ strength: Number.NaN })).toThrow(RangeError);
    expect(() => spotlight({ followMs: '90' as unknown as number })).toThrow(TypeError);
    expect(() =>
      spotlight({ color: [1, 2, 3] as unknown as [number, number, number, number] }),
    ).toThrow();
  });

  it('lands on the pointer at once with no follow, and reports settled', () => {
    const shade = spotlight({
      radiusPx: 100,
      strength: 0.5,
      color: [1, 0.5, 0.25, 1],
      followMs: 0,
    });
    const host = new Float32Array(SHADE_HOST_WORDS);

    expect(shade.tick!(host, frame(0, [40, 30]))).toBe(false);
    expect(Array.from(host.subarray(0, 8))).toEqual([40, 30, 100 * 100, 0.5, 1, 0.5, 0.25, 1]);

    // Leaving parks the light off-canvas at zero strength.
    expect(shade.tick!(host, frame(16, null))).toBe(false);
    expect(host[0]).toBe(POINTER_NONE);
    expect(host[3]).toBe(0);
  });

  it('chases the pointer and fades out, asking for frames only while moving', () => {
    const shade = spotlight({ followMs: 90, strength: 1 });
    const host = new Float32Array(SHADE_HOST_WORDS);

    // The first sighting seeds the position; the strength still eases in from zero.
    expect(shade.tick!(host, frame(0, [100, 100]))).toBe(true);
    expect(host[0]).toBe(100);
    expect(host[3]).toBe(0);

    shade.tick!(host, frame(90, [200, 100]));
    expect(host[0]).toBeGreaterThan(100);
    expect(host[0]).toBeLessThan(200);
    expect(host[3]).toBeGreaterThan(0.5);
    expect(host[3]).toBeLessThan(1);

    // Frame after frame it lands exactly and the tick goes quiet.
    let animating = true;
    let t = 180;
    for (; animating && t < 5000; t += 16) {
      animating = shade.tick!(host, frame(t, [200, 100]));
    }
    expect(animating).toBe(false);
    expect(Array.from(host.subarray(0, 4))).toEqual([200, 100, 200 * 200, 1]);

    // Fading out after the pointer leaves keeps the last position until it has gone.
    expect(shade.tick!(host, frame(t, null))).toBe(true);
    expect(host[0]).toBe(200);
    expect(host[3]).toBeLessThan(1);
    animating = true;
    for (t += 16; animating && t < 10000; t += 16) {
      animating = shade.tick!(host, frame(t, null));
    }
    expect(animating).toBe(false);
    expect(host[0]).toBe(POINTER_NONE);
    expect(host[3]).toBe(0);
  });
});
