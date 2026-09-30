import { expect, it } from 'vitest';
import { cameraPoint, fitCamera, worldPoint, zoomCamera } from '../src/index.js';
const viewport = { width: 800, height: 600, pixelRatio: 2 };
it('fits asymmetric padding and roundtrips large coordinates in double precision', () => {
  const camera = fitCamera([1e12, 1e12, 1e12 + 100, 1e12 + 50], viewport, [20, 40, 60, 120]);
  const center = cameraPoint(camera, [1e12 + 50, 1e12 + 25], viewport);
  expect(center[0]).toBeCloseTo(440, 2);
  expect(center[1]).toBeCloseTo(280, 2);
  const point = [1e12 + 0.125, 1e12 + 10.5] as const;
  expect(worldPoint(camera, cameraPoint(camera, point, viewport), viewport)).toEqual(point);
});
it('keeps the pointer anchor fixed while zooming', () => {
  const camera = { centerX: 500, centerY: -200, scale: 2 },
    anchor = [111, 222] as const;
  const before = worldPoint(camera, anchor, viewport),
    next = zoomCamera(camera, 3, anchor, viewport);
  expect(worldPoint(next, anchor, viewport)).toEqual(before);
});
it('handles degenerate bounds and rejects invalid fit and zoom inputs', () => {
  expect(fitCamera([5, 5, 5, 5], viewport).scale).toBe(64);
  expect(() => fitCamera([2, 0, 1, 1], viewport)).toThrow();
  expect(() => fitCamera([0, 0, 1, 1], viewport, -1)).toThrow();
  expect(() => zoomCamera({ centerX: 0, centerY: 0, scale: 1 }, 0, [0, 0], viewport)).toThrow();
});
