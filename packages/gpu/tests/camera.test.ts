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
  const camera = {
      center: [500, -200] as const,
      scale: [2, 2] as const,
      yDirection: 'up' as const,
    },
    anchor = [111, 222] as const;
  const before = worldPoint(camera, anchor, viewport),
    next = zoomCamera(camera, 3, anchor, viewport);
  expect(worldPoint(next, anchor, viewport)).toEqual(before);
});
it('handles degenerate bounds and rejects invalid fit and zoom inputs', () => {
  expect(fitCamera([5, 5, 5, 5], viewport).scale).toEqual([64, 64]);
  expect(() => fitCamera([2, 0, 1, 1], viewport)).toThrow();
  expect(() => fitCamera([0, 0, 1, 1], viewport, -1)).toThrow();
  expect(() =>
    zoomCamera({ center: [0, 0], scale: [1, 1], yDirection: 'up' }, 0, [0, 0], viewport),
  ).toThrow();
});

it('fits independent axes and keeps anchors with downward world coordinates', () => {
  const camera = fitCamera([0, 0, 100, 10], viewport, 0, {
    aspect: 'independent',
    yDirection: 'down',
  });
  expect(camera.scale).toEqual([8, 60]);
  expect(cameraPoint(camera, [0, 0], viewport)).toEqual([0, 0]);
  expect(cameraPoint(camera, [100, 10], viewport)).toEqual([800, 600]);
  const anchor = [37, 83] as const,
    before = worldPoint(camera, anchor, viewport);
  expect(worldPoint(zoomCamera(camera, [2, 4], anchor, viewport), anchor, viewport)).toEqual(
    before,
  );
});
