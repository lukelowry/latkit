import { describe, expect, it } from 'vitest';
import { FIT_PAD, type GraphBounds, type Viewport } from '../src/camera/projection.js';
import { VISUAL, planeHeightWorldScale } from '../src/visual.js';

const bounds: GraphBounds = { xMin: 0, xMax: 100, yMin: 0, yMax: 50 };

describe('planeHeightWorldScale', () => {
  it('targets a stable pixel height at fit', () => {
    const vp: Viewport = { w: 1000, h: 500 };
    const pxPerWorld = Math.min((vp.w * FIT_PAD) / 100, (vp.h * FIT_PAD) / 50);

    expect(planeHeightWorldScale(bounds, vp, 0.5)).toBeCloseTo(
      VISUAL.heightTargetPx / pxPerWorld,
      6,
    );
  });

  it('keeps a minimum height budget in vertex radii', () => {
    const scale = planeHeightWorldScale(bounds, { w: 10_000, h: 5_000 }, 1);

    expect(scale).toBeCloseTo(VISUAL.heightMinVertexRadii, 6);
  });

  it('caps height against the graph footprint', () => {
    const scale = planeHeightWorldScale(bounds, { w: 1, h: 1 }, 1);

    expect(scale).toBeCloseTo(100 * VISUAL.heightMaxExtentFraction, 6);
  });
});
