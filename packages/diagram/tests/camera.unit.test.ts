import { describe, expect, it } from 'vitest';

import { Camera, type Viewport } from '../src/camera.js';
import type { Rect } from '../src/geometry.js';

const VP: Viewport = { w: 800, h: 600 };
const NONE: Viewport = { w: 0, h: 0 };
/** 400 x 200 diagram units centered on (200, 100). */
const CONTENT: Rect = [0, 0, 400, 200];

/** A camera placed at the default fit of `CONTENT` in `VP`. */
function placed(): Camera {
  const camera = new Camera();
  camera.setBounds(CONTENT, true);
  camera.tick(0, VP);
  return camera;
}

describe('placement', () => {
  it('stays unplaced with zoom 0 until a viewport has area', () => {
    const camera = new Camera();
    expect(camera.placed).toBe(false);
    expect(camera.pose).toEqual({ centerX: 0, centerY: 0, zoom: 0 });

    camera.setBounds(CONTENT, true);
    expect(camera.tick(0, NONE)).toBe(false);
    expect(camera.placed).toBe(false);
    expect(camera.pose.zoom).toBe(0);
    expect(camera.toDiagram(10, 10, VP)).toEqual([NaN, NaN]);
    expect(camera.toScreen(10, 10, VP)).toEqual([NaN, NaN]);
    expect(camera.view(VP)).toEqual([NaN, NaN, NaN, NaN]);
    expect(camera.panBy(10, 0)).toBe(false);
    expect(camera.zoomAt(2, 0, 0, VP)).toBe(false);
    expect(camera.isAtFit()).toBe(false);

    // The first tick with area places the deferred fit at once; it does not ease.
    expect(camera.tick(16, VP)).toBe(false);
    expect(camera.placed).toBe(true);
    expect(camera.animating).toBe(false);
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 1.8 });
    expect(camera.isAtFit()).toBe(true);
  });

  it('places at once when a viewport with area is already known', () => {
    const camera = placed();
    camera.reset();
    expect(camera.placed).toBe(false);
    expect(camera.pose.zoom).toBe(0);
    camera.tick(0, VP);

    camera.setBounds([0, 0, 100, 100], true);
    expect(camera.placed).toBe(true);
    expect(camera.pose).toEqual({ centerX: 50, centerY: 50, zoom: 5.4 });
  });

  it('forgets everything on reset, keeping only the fit insets', () => {
    const camera = placed();
    camera.setPadding(200);
    camera.moveTo([0, 0, 100, 100], NONE, false, 0);
    camera.reset();
    expect(camera.placed).toBe(false);
    expect(camera.animating).toBe(false);
    expect(camera.isAtFit()).toBe(false);
    expect(camera.pose).toEqual({ centerX: 0, centerY: 0, zoom: 0 });
    // Nothing deferred survives: no fit and no move land on the next viewport.
    expect(camera.tick(0, VP)).toBe(false);
    expect(camera.placed).toBe(false);
    camera.setBounds(CONTENT, true);
    expect(camera.pose.zoom).toBeCloseTo(1, 12);
  });

  it('places even without `fit` when the camera has no pose yet', () => {
    const camera = new Camera();
    camera.setBounds(CONTENT, false);
    camera.tick(0, VP);
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 1.8 });
  });

  it('keeps an explored pose when new bounds arrive without `fit`', () => {
    const camera = placed();
    camera.panBy(40, 0);
    const before = camera.pose;
    camera.setBounds([0, 0, 800, 400], false);
    expect(camera.pose).toEqual(before);
  });

  it('applies a pose requested before placement over the placing fit', () => {
    const camera = new Camera();
    camera.setBounds(CONTENT, true);
    expect(camera.setPose({ zoom: 2 }, true, 300)).toBe(true);
    expect(camera.setPose({ centerX: 10 }, false, 0)).toBe(true);
    camera.tick(0, VP);
    expect(camera.pose).toEqual({ centerX: 10, centerY: 100, zoom: 2 });
    expect(camera.animating).toBe(false);
    expect(camera.isAtFit()).toBe(false);
  });
});

describe('fit', () => {
  it('fills 90% of the limiting dimension by default', () => {
    const camera = placed();
    // Width limits: 800 * 0.9 / 400 = 1.8 (height would allow 2.7).
    expect(camera.pose.zoom).toBeCloseTo(1.8, 12);
    expect(camera.view(VP)).toEqual([
      200 - 400 / 1.8,
      100 - 300 / 1.8,
      200 + 400 / 1.8,
      100 + 300 / 1.8,
    ]);
  });

  it('insets by padding, and asymmetric insets shift the center', () => {
    const camera = placed();
    camera.fit(CONTENT, VP, [0, 0, 0, 200], false, 0);
    // 600 px of width left over for 400 units, content centered in the right 600 px.
    expect(camera.pose.zoom).toBeCloseTo(1.5, 12);
    const [left] = camera.toScreen(0, 100, VP);
    const [right] = camera.toScreen(400, 100, VP);
    expect(left).toBeCloseTo(200, 9);
    expect(right).toBeCloseTo(800, 9);

    camera.fit(CONTENT, VP, [100, 0, 0, 0], false, 0);
    const [, top] = camera.toScreen(200, 0, VP);
    const [, bottom] = camera.toScreen(200, 200, VP);
    expect(top - 100).toBeCloseTo(600 - bottom, 9);

    camera.fit(CONTENT, VP, 50, false, 0);
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 700 / 400 });
  });

  it('keeps showing something when the insets exceed the canvas', () => {
    const camera = placed();
    camera.fit(CONTENT, VP, 1000, false, 0);
    expect(camera.pose.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(camera.pose.zoom)).toBe(true);
  });

  it('eases with cubic in-out, stamping its start on the first tick', () => {
    const camera = placed();
    camera.setPose({ centerX: 0, centerY: 0, zoom: 1 }, false, 0);
    camera.fit([100, 0, 300, 200], VP, null, true, 100);
    expect(camera.animating).toBe(true);
    expect(camera.isAtFit()).toBe(false);

    expect(camera.tick(1000, VP)).toBe(true);
    expect(camera.pose).toEqual({ centerX: 0, centerY: 0, zoom: 1 });

    // Target: center (200, 100), zoom min(720 / 200, 540 / 200) = 2.7.
    camera.tick(1025, VP);
    const quarter = 4 * 0.25 ** 3;
    expect(camera.pose.centerX).toBeCloseTo(200 * quarter, 9);
    expect(camera.pose.zoom).toBeCloseTo(2.7 ** quarter, 9);

    camera.tick(1050, VP);
    expect(camera.pose.centerX).toBeCloseTo(100, 9);
    camera.tick(1075, VP);
    expect(camera.pose.centerX).toBeCloseTo(200 * (1 - quarter), 9);

    expect(camera.tick(1100, VP)).toBe(false);
    expect(camera.animating).toBe(false);
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 2.7 });
    expect(camera.isAtFit()).toBe(true);
  });

  it('jumps without animation or duration', () => {
    const camera = placed();
    camera.panBy(100, 0);
    camera.fit(CONTENT, VP, null, true, 0);
    expect(camera.animating).toBe(false);
    expect(camera.isAtFit()).toBe(true);
  });

  it('defers a fit until the viewport has area', () => {
    const camera = placed();
    camera.panBy(100, 0);
    camera.fit([0, 0, 100, 100], NONE, null, true, 300);
    expect(camera.animating).toBe(false);
    expect(camera.pose.centerX).not.toBe(50);
    camera.tick(0, NONE);
    camera.tick(16, VP);
    expect(camera.pose).toEqual({ centerX: 50, centerY: 50, zoom: 5.4 });
  });

  it('follows a resize while at fit, and stops following once explored', () => {
    const camera = placed();
    camera.tick(16, { w: 400, h: 600 });
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 0.9 });
    expect(camera.isAtFit()).toBe(true);

    camera.panBy(10, 0);
    camera.tick(32, VP);
    expect(camera.pose.zoom).toBe(0.9);
    expect(camera.isAtFit()).toBe(false);
  });

  it('retargets an eased fit when the viewport resizes mid-flight', () => {
    const camera = placed();
    camera.panBy(200, 0);
    camera.fit(CONTENT, VP, null, true, 100);
    camera.tick(0, VP);
    camera.tick(50, { w: 400, h: 600 });
    expect(camera.animating).toBe(true);
    camera.tick(100, { w: 400, h: 600 });
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 0.9 });
    expect(camera.isAtFit()).toBe(true);
  });

  it('re-frames on new padding while at fit', () => {
    const camera = placed();
    camera.setPadding(200);
    expect(camera.pose.zoom).toBeCloseTo(1, 12);
    expect(camera.isAtFit()).toBe(true);
  });

  it('compares with the last fit target within 0.5 CSS px and 0.1% zoom', () => {
    const camera = placed();
    const { centerX, zoom } = camera.pose;
    camera.setPose({ centerX: centerX + 0.4 / zoom }, false, 0);
    expect(camera.isAtFit()).toBe(true);
    camera.setPose({ centerX: centerX + 0.6 / zoom }, false, 0);
    expect(camera.isAtFit()).toBe(false);
    camera.setPose({ centerX, zoom: zoom * 1.0009 }, false, 0);
    expect(camera.isAtFit()).toBe(true);
    camera.setPose({ zoom: zoom * 1.002 }, false, 0);
    expect(camera.isAtFit()).toBe(false);
  });
});

describe('content-free bounds', () => {
  it('place an unplaced camera at once, at the origin at actual size, without a viewport', () => {
    const camera = new Camera();
    camera.setBounds(null, true);
    expect(camera.placed).toBe(true);
    expect(camera.pose).toEqual({ centerX: 0, centerY: 0, zoom: 1 });
    expect(camera.isAtFit()).toBe(true);
    expect(camera.toDiagram(400, 300, VP)).toEqual([0, 0]);
    expect(camera.toDiagram(410, 280, VP)).toEqual([10, -20]);
    expect(camera.panBy(30, 0)).toBe(true);
    expect(camera.pose.centerX).toBe(-30);
    expect(camera.isAtFit()).toBe(false);
    // Without content the zoom spans [0.25, 8].
    expect(camera.zoomAt(1000, 400, 300, VP)).toBe(true);
    expect(camera.pose.zoom).toBe(8);
    camera.setPose({ zoom: 0.001 }, false, 0);
    expect(camera.pose.zoom).toBe(0.25);
  });

  it('apply a pose requested before placement over the origin', () => {
    const camera = new Camera();
    expect(camera.setPose({ centerX: 10, zoom: 2 }, false, 0)).toBe(true);
    camera.setBounds(null, false);
    expect(camera.pose).toEqual({ centerX: 10, centerY: 0, zoom: 2 });
    expect(camera.isAtFit()).toBe(false);
  });

  it('keep a placed pose, which becomes the fit view under `fit`', () => {
    const camera = placed();
    camera.panBy(40, 0);
    const explored = camera.pose;
    camera.setBounds(null, false);
    expect(camera.pose).toEqual(explored);
    expect(camera.isAtFit()).toBe(false);

    camera.setBounds(null, true);
    expect(camera.pose).toEqual(explored);
    expect(camera.isAtFit()).toBe(true);
    // Nothing to follow: a resize leaves the pose.
    camera.tick(16, { w: 400, h: 600 });
    expect(camera.pose).toEqual(explored);

    // Content again: a fit frames it.
    camera.setBounds(CONTENT, true);
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 0.9 });
  });

  it('stop an easing under `fit`, and let one run without it', () => {
    const camera = placed();
    camera.setPose({ centerX: 1000 }, true, 100);
    camera.tick(0, VP);
    camera.tick(50, VP);
    camera.setBounds(null, false);
    expect(camera.animating).toBe(true);
    camera.setBounds(null, true);
    expect(camera.animating).toBe(false);
    expect(camera.isAtFit()).toBe(true);
  });
});

describe('moveTo', () => {
  it('frames bounds without redefining the fit view', () => {
    const camera = placed();
    camera.moveTo([0, 0, 100, 100], VP, false, 0);
    expect(camera.pose).toEqual({ centerX: 50, centerY: 50, zoom: 5.4 });
    expect(camera.isAtFit()).toBe(false);

    // A resize keeps the pose: only a fit is followed.
    camera.tick(16, { w: 400, h: 600 });
    expect(camera.pose).toEqual({ centerX: 50, centerY: 50, zoom: 5.4 });

    // The fit view is still the whole content's.
    camera.tick(32, VP);
    camera.setPose({ centerX: 200, centerY: 100, zoom: 1.8 }, false, 0);
    expect(camera.isAtFit()).toBe(true);
  });

  it('honors the fit insets and clamps the zoom', () => {
    const camera = placed();
    camera.setPadding([0, 0, 0, 200]);
    camera.moveTo(CONTENT, VP, false, 0);
    expect(camera.pose.zoom).toBeCloseTo(1.5, 12);
    camera.moveTo([10, 10, 12, 12], VP, false, 0);
    expect(camera.pose.zoom).toBe(8);
  });

  it('eases when asked, and replaces an easing in flight', () => {
    const camera = placed();
    camera.panBy(100, 0);
    camera.fit(CONTENT, VP, null, true, 100);
    camera.tick(0, VP);
    camera.tick(50, VP);
    camera.moveTo([0, 0, 100, 100], VP, true, 100);
    expect(camera.animating).toBe(true);
    camera.tick(60, VP);
    camera.tick(160, VP);
    expect(camera.animating).toBe(false);
    expect(camera.pose).toEqual({ centerX: 50, centerY: 50, zoom: 5.4 });
    expect(camera.isAtFit()).toBe(false);
  });

  it('takes the camera from its fit even when it lands where it is', () => {
    const camera = placed();
    camera.moveTo(CONTENT, VP, false, 0);
    expect(camera.pose).toEqual({ centerX: 200, centerY: 100, zoom: 1.8 });
    // At the fit pose, yet no longer following it.
    expect(camera.isAtFit()).toBe(true);
    camera.tick(16, { w: 400, h: 600 });
    expect(camera.pose.zoom).toBe(1.8);
  });

  it('defers until the camera is placed and a viewport has area, then lands without easing', () => {
    const camera = new Camera();
    camera.setBounds(CONTENT, true);
    camera.setPose({ zoom: 2 }, false, 0);
    camera.moveTo([0, 0, 100, 100], NONE, true, 300);
    expect(camera.placed).toBe(false);
    camera.tick(0, NONE);
    expect(camera.placed).toBe(false);
    camera.tick(16, VP);
    expect(camera.placed).toBe(true);
    expect(camera.animating).toBe(false);
    // The move replaced the pose asked for before it.
    expect(camera.pose).toEqual({ centerX: 50, centerY: 50, zoom: 5.4 });
    expect(camera.isAtFit()).toBe(false);

    const detached = placed();
    detached.moveTo([0, 0, 100, 100], NONE, true, 300);
    expect(detached.pose).toEqual({ centerX: 200, centerY: 100, zoom: 1.8 });
    detached.tick(16, VP);
    expect(detached.animating).toBe(false);
    expect(detached.pose).toEqual({ centerX: 50, centerY: 50, zoom: 5.4 });
  });

  it('gives way to a newer command before it lands', () => {
    const posed = placed();
    posed.moveTo([0, 0, 100, 100], NONE, false, 0);
    expect(posed.setPose({ centerX: 200 }, false, 0)).toBe(true);
    posed.tick(16, VP);
    expect(posed.pose).toEqual({ centerX: 200, centerY: 100, zoom: 1.8 });

    const fitted = placed();
    fitted.moveTo([0, 0, 100, 100], NONE, false, 0);
    fitted.fit(CONTENT, VP, null, false, 0);
    fitted.tick(16, VP);
    expect(fitted.isAtFit()).toBe(true);

    const reloaded = placed();
    reloaded.moveTo([0, 0, 100, 100], NONE, false, 0);
    reloaded.setBounds([0, 0, 800, 400], false);
    reloaded.tick(16, VP);
    expect(reloaded.pose).toEqual({ centerX: 200, centerY: 100, zoom: 1.8 });
  });
});

describe('claim', () => {
  it('leaves an idle camera, and its fit, as they are', () => {
    const camera = placed();
    expect(camera.claim()).toBe(false);
    expect(camera.isAtFit()).toBe(true);
    camera.tick(16, { w: 400, h: 600 });
    expect(camera.pose.zoom).toBe(0.9);
  });

  it('stops an easing where it is and leaves the fit', () => {
    const camera = placed();
    camera.panBy(200, 0);
    camera.fit(CONTENT, VP, null, true, 100);
    camera.tick(0, VP);
    camera.tick(50, VP);
    const mid = camera.pose;
    expect(camera.claim()).toBe(true);
    expect(camera.animating).toBe(false);
    expect(camera.pose).toEqual(mid);
    expect(camera.tick(100, VP)).toBe(false);
    expect(camera.pose).toEqual(mid);
    // No longer following the fit: a resize keeps the pose.
    camera.tick(116, { w: 400, h: 600 });
    expect(camera.pose).toEqual(mid);
  });

  it('drops a deferred move and a deferred re-fit', () => {
    const moved = placed();
    moved.moveTo([0, 0, 100, 100], NONE, false, 0);
    expect(moved.claim()).toBe(false);
    moved.tick(16, VP);
    expect(moved.pose).toEqual({ centerX: 200, centerY: 100, zoom: 1.8 });

    const refit = placed();
    refit.panBy(100, 0);
    const explored = refit.pose;
    refit.fit(CONTENT, NONE, null, false, 0);
    expect(refit.claim()).toBe(true);
    refit.tick(16, VP);
    expect(refit.pose).toEqual(explored);
  });
});

describe('zoom limits', () => {
  it('clamps to [min(fitZoom / 4, 0.25), 8]', () => {
    const camera = placed();
    camera.setPose({ zoom: 100 }, false, 0);
    expect(camera.pose.zoom).toBe(8);
    // fitZoom 1.8: the floor is 0.25, not 0.45.
    camera.setPose({ zoom: 0.01 }, false, 0);
    expect(camera.pose.zoom).toBe(0.25);

    // Content far larger than the viewport lowers the floor to a quarter of its fit.
    camera.setBounds([0, 0, 40000, 20000], true);
    expect(camera.pose.zoom).toBeCloseTo(0.018, 12);
    camera.setPose({ zoom: 0.0001 }, false, 0);
    expect(camera.pose.zoom).toBeCloseTo(0.0045, 12);
  });

  it('caps the fit of tiny content at the closest zoom', () => {
    const camera = new Camera();
    camera.setBounds([10, 10, 12, 12], true);
    camera.tick(0, VP);
    expect(camera.pose).toEqual({ centerX: 11, centerY: 11, zoom: 8 });
    expect(camera.isAtFit()).toBe(true);

    camera.setBounds([5, 5, 5, 5], true);
    expect(camera.pose).toEqual({ centerX: 5, centerY: 5, zoom: 8 });
  });

  it('stops a wheel zoom at a limit without moving', () => {
    const camera = placed();
    camera.setPose({ zoom: 8 }, false, 0);
    const before = camera.pose;
    expect(camera.zoomAt(2, 0, 0, VP)).toBe(false);
    expect(camera.pose).toEqual(before);
  });
});

describe('gestures', () => {
  it('pans the content by CSS pixels', () => {
    const camera = placed();
    const [x, y] = camera.toScreen(50, 60, VP);
    expect(camera.panBy(30, -20)).toBe(true);
    const [x2, y2] = camera.toScreen(50, 60, VP);
    expect(x2 - x).toBeCloseTo(30, 9);
    expect(y2 - y).toBeCloseTo(-20, 9);
    expect(camera.panBy(0, 0)).toBe(false);
    expect(camera.panBy(Number.NaN, 0)).toBe(false);
  });

  it('zooms about the cursor, keeping the diagram point under it', () => {
    const camera = placed();
    const [px, py] = camera.toDiagram(123, 456, VP);
    expect(camera.zoomAt(1.5, 123, 456, VP)).toBe(true);
    expect(camera.pose.zoom).toBeCloseTo(2.7, 12);
    const [qx, qy] = camera.toDiagram(123, 456, VP);
    expect(qx).toBeCloseTo(px, 9);
    expect(qy).toBeCloseTo(py, 9);
    expect(camera.zoomAt(0, 0, 0, VP)).toBe(false);
    expect(camera.zoomAt(2, 0, 0, NONE)).toBe(false);
  });

  it('cancels an easing, leaving the pose where the easing was', () => {
    const camera = placed();
    camera.setPose({ centerX: 1000 }, true, 100);
    camera.tick(0, VP);
    camera.tick(50, VP);
    const mid = camera.pose;
    expect(camera.panBy(0, 0)).toBe(false);
    expect(camera.animating).toBe(false);
    expect(camera.pose).toEqual(mid);
    expect(camera.tick(60, VP)).toBe(false);

    camera.setPose({ centerX: 0 }, true, 100);
    camera.tick(100, VP);
    camera.zoomAt(1.1, 400, 300, VP);
    expect(camera.animating).toBe(false);
  });
});

describe('setPose', () => {
  it('merges, clamps, and reports whether anything changed', () => {
    const camera = placed();
    expect(camera.setPose({}, false, 0)).toBe(false);
    expect(camera.setPose({ centerX: 200 }, false, 0)).toBe(false);
    expect(camera.setPose({ centerY: -50 }, false, 0)).toBe(true);
    expect(camera.pose).toEqual({ centerX: 200, centerY: -50, zoom: 1.8 });
    expect(camera.isAtFit()).toBe(false);
  });

  it('eases when asked', () => {
    const camera = placed();
    expect(camera.setPose({ centerX: 300, zoom: 3.6 }, true, 200)).toBe(true);
    expect(camera.animating).toBe(true);
    camera.tick(0, VP);
    camera.tick(100, VP);
    expect(camera.pose.centerX).toBeCloseTo(250, 9);
    expect(camera.pose.zoom).toBeCloseTo(1.8 * Math.SQRT2, 9);
    camera.tick(200, VP);
    expect(camera.pose).toEqual({ centerX: 300, centerY: 100, zoom: 3.6 });
  });

  it('throws before changing anything on a bad field', () => {
    const camera = placed();
    const before = camera.pose;
    expect(() => camera.setPose({ centerX: Number.NaN }, false, 0)).toThrow(/centerX/);
    expect(() => camera.setPose({ centerY: Infinity }, false, 0)).toThrow(/centerY/);
    expect(() => camera.setPose({ centerX: 5, zoom: 0 }, false, 0)).toThrow(RangeError);
    expect(() => camera.setPose({ zoom: -1 }, false, 0)).toThrow(/zoom/);
    expect(camera.pose).toEqual(before);
  });
});

describe('conversions', () => {
  it('maps screen and diagram points both ways around the viewport center', () => {
    const camera = placed();
    expect(camera.toDiagram(400, 300, VP)).toEqual([200, 100]);
    expect(camera.toScreen(200, 100, VP)).toEqual([400, 300]);
    const [x, y] = camera.toDiagram(40, 500, VP);
    const [sx, sy] = camera.toScreen(x, y, VP);
    expect(sx).toBeCloseTo(40, 9);
    expect(sy).toBeCloseTo(500, 9);
    // y grows downward on screen and in the diagram alike.
    expect(camera.toDiagram(400, 400, VP)[1]).toBeGreaterThan(100);
  });
});
