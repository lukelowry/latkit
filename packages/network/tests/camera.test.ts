import { expect, it } from 'vitest';
import { initialCamera, project } from '../src/camera.js';
const viewport = { width: 800, height: 600, pixelRatio: 2 };
it('keeps sub-unit positions near a large origin distinct', () => {
  const camera = initialCamera({ centerX: 1e12, centerY: 1e12, scale: 100 });
  const a = project(camera, viewport, 1e12, 1e12),
    b = project(camera, viewport, 1e12 + 0.125, 1e12);
  expect(b.x - a.x).toBe(12.5);
  expect(a.depth).toBe(0.5);
});
it('projects the globe anchor to the center and rejects the far hemisphere', () => {
  const camera = initialCamera({ projection: 'globe', centerX: -75, centerY: 30, scale: 5 });
  const near = project(camera, viewport, -75, 30),
    far = project(camera, viewport, 105, -30);
  expect(near.x).toBeCloseTo(400);
  expect(near.y).toBeCloseTo(300);
  expect(near.visible).toBe(true);
  expect(far.visible).toBe(false);
});
it('rejects invalid camera scale and pitch', () => {
  expect(() => initialCamera({ scale: 0 })).toThrow();
  expect(() => initialCamera({ pitch: 81 })).toThrow();
});

it('clips near-plane crossings instead of discarding both endpoints', async () => {
  const { project, projectedStroke, initialCamera } = await import('../src/camera.js');
  const camera = initialCamera({ projection: 'tilt', pitch: 0, scale: 1, fit: false }),
    viewport = { width: 800, height: 600, pixelRatio: 1 };
  const a = project(camera, viewport, -10, 0, 1000),
    b = project(camera, viewport, 10, 0, 0);
  expect(a.visible).toBe(false);
  expect(b.visible).toBe(true);
  const stroke = projectedStroke(a, b, camera, viewport)!;
  expect(stroke).not.toBeNull();
  expect(stroke[0].depth).toBeCloseTo(0);
  expect(stroke[1].depth).toBeGreaterThan(0);
});
