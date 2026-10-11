import { describe, expect, it } from 'vitest';
import { kit, type ProjectedCamera } from '../src/index.js';

const { Projector } = kit;
const viewport = { width: 800, height: 600, pixelRatio: 1 };
const camera = (patch: Partial<ProjectedCamera>): ProjectedCamera =>
  Projector.check({ ...Projector.camera, ...patch });

describe('projector', () => {
  it('finds the model point under each canvas point, as it projects it', () => {
    const cameras = [
      camera({ projection: 'flat', center: [10, 20], scale: 40, bearing: 30 }),
      camera({ projection: 'mercator', center: [-97, 31], scale: 60, bearing: -15 }),
      camera({ projection: 'tilt', center: [5, -3], scale: 50, pitch: 50, bearing: 70 }),
      camera({ projection: 'globe', center: [-100, 35], scale: 6, pitch: 30, bearing: 20 }),
    ];
    for (const view of cameras) {
      const projector = new Projector(view, viewport);
      for (const [dx, dy] of [
        [0, 0],
        [1.5, -0.8],
        [-2.2, 1.1],
        [0.4, 2.4],
      ]) {
        const x = view.center[0] + dx,
          y = view.center[1] + dy;
        const p = projector.project(x, y);
        expect(p.visible).toBe(true);
        const back = projector.unproject([p.x, p.y])!;
        expect(back[0]).toBeCloseTo(x, 5);
        expect(back[1]).toBeCloseTo(y, 5);
      }
    }
  });

  it('places latitudes on the mercator plane and back', () => {
    for (const latitude of [-80, -45, -1, 0, 12.5, 60, 85]) {
      expect(Projector.latitude(Projector.mercator(latitude))).toBeCloseTo(latitude, 9);
    }
    expect(Projector.mercator(0)).toBeCloseTo(0, 12);
    // Mercator stretches toward the poles.
    expect(Projector.mercator(60)).toBeGreaterThan(60);
  });

  it('frames bounds on the mercator plane, and moves and zooms along it', () => {
    const fitted = Projector.fit(
      camera({ projection: 'mercator' }),
      [-100, 25, -90, 50],
      viewport,
      0,
      { pitch: 45, bearing: 0 },
    );
    expect(fitted.pitch).toBe(0);
    const projector = new Projector(fitted, viewport);
    // The bounds' corners land inside the viewport, one pair of sides on its edges.
    const south = projector.project(-95, 25),
      north = projector.project(-95, 50);
    expect(Math.min(south.y, north.y)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.max(south.y, north.y)).toBeLessThanOrEqual(viewport.height + 1e-6);
    expect(Math.abs(north.y - south.y)).toBeCloseTo(viewport.height, 4);
    // A zoom keeps the point under its anchor where it is.
    const anchor = [200, 150] as const,
      before = projector.unproject(anchor)!,
      zoomed = new Projector(Projector.zoom(fitted, 3, anchor, viewport), viewport),
      after = zoomed.unproject(anchor)!;
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    // Panning by pixels moves a point under the pointer by as many pixels.
    const moved = new Projector(Projector.move(fitted, 30, -20), viewport),
      p = projector.project(-95, 40),
      q = moved.project(-95, 40);
    expect(q.x - p.x).toBeCloseTo(30, 6);
    expect(q.y - p.y).toBeCloseTo(-20, 6);
  });

  it('checks cameras and holds pitch only where the projection pitches', () => {
    expect(camera({ projection: 'flat', pitch: 40 }).pitch).toBe(0);
    expect(camera({ projection: 'tilt', pitch: 40 }).pitch).toBe(40);
    expect(() => camera({ scale: 0 })).toThrow('Invalid camera');
    expect(() => camera({ projection: 'sphere' as ProjectedCamera['projection'] })).toThrow();
    expect(kit.PROJECTIONS.mercator).toEqual({ geographic: true, pitched: false });
  });

  it('keeps sub-unit positions near a large origin distinct', () => {
    const projector = new Projector(camera({ center: [1e12, 1e12], scale: 100 }), {
      ...viewport,
      pixelRatio: 2,
    });
    const a = projector.project(1e12, 1e12),
      b = projector.project(1e12 + 0.125, 1e12);
    expect(b.x - a.x).toBe(12.5);
    expect(a.depth).toBe(0.5);
  });

  it('projects the globe’s anchor to the center and rejects the far hemisphere', () => {
    const projector = new Projector(
      camera({ projection: 'globe', center: [-75, 30], scale: 5 }),
      viewport,
    );
    const near = projector.project(-75, 30),
      far = projector.project(105, -30);
    expect(near.x).toBeCloseTo(400);
    expect(near.y).toBeCloseTo(300);
    expect(near.visible).toBe(true);
    expect(far.visible).toBe(false);
    expect(() => camera({ pitch: 81 })).toThrow();
  });

  it('clips near-plane crossings instead of discarding both endpoints', () => {
    const projector = new Projector(
      camera({ projection: 'tilt', pitch: 0, scale: 1, fit: false }),
      viewport,
    );
    const a = projector.project(-10, 0, 1000),
      b = projector.project(10, 0, 0);
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(true);
    const stroke = projector.stroke(a, b)!;
    expect(stroke).not.toBeNull();
    expect(stroke[0].depth).toBeCloseTo(0);
    expect(stroke[1].depth).toBeGreaterThan(0);
  });

  it('hides the globe’s far side and writes the block shaders read', () => {
    const view = camera({ projection: 'globe', center: [0, 0], scale: 4 }),
      projector = new Projector(view, viewport);
    expect(projector.project(0, 0).visible).toBe(true);
    expect(projector.project(180, 0).visible).toBe(false);
    const block = new Float32Array(Projector.floats);
    projector.write(block, 0, true, 0.1);
    expect(block[3]).toBe(2);
    expect(block[14]).toBeCloseTo(0.1);
    expect(block[15]).toBe(1);
    const light = new Float32Array(8);
    Projector.light(light, 0, { sun: [1, 0, 0], nightFloor: 0.4, terminatorWidth: 0.1 });
    expect([...light.subarray(0, 6)].map((v) => +v.toFixed(3))).toEqual([1, 0, 0, 1, 0.4, 0.1]);
    Projector.light(light, 0, null);
    expect(light.every((v) => v === 0)).toBe(true);
  });
});
