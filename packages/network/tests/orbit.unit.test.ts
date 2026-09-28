import { describe, expect, it, vi } from 'vitest';

import { canOrbit, createOrbit, type OrbitTarget } from '../src/orbit.js';
import type { Pose } from '../src/camera/projection.js';
import type { Projection } from '../src/projections.js';

/** A projection-honoring camera stub. */
function target(initial: Projection, modes: Partial<Record<Projection, boolean>> = {}) {
  const projections: Record<Projection, boolean> = {
    flat: true,
    tilt: true,
    globe: true,
    ...modes,
  };
  let pose: Pose | null = { centerX: -90, centerY: 30, pitch: 20, bearing: 5 };
  const net = {
    projection: initial,
    projections,
    setProjection: vi.fn((mode: Projection): boolean => {
      if (!projections[mode]) return false;
      net.projection = mode;
      return true;
    }),
    rotateBy: vi.fn(),
    getPose: vi.fn(() => pose),
    setPose: vi.fn((next: Partial<Pose>): boolean => {
      if (pose) pose = { ...pose, ...next };
      return pose !== null;
    }),
  } satisfies OrbitTarget;
  return net;
}

describe('canOrbit', () => {
  it('permits rotation for any 3D view and for flat only when tilt is offered', () => {
    const modes = (tilt: boolean) => ({ flat: true, tilt, globe: false });
    expect(canOrbit({ projection: 'globe', projections: modes(false) })).toBe(true);
    expect(canOrbit({ projection: 'tilt', projections: modes(true) })).toBe(true);
    expect(canOrbit({ projection: 'flat', projections: modes(true) })).toBe(true);
    expect(canOrbit({ projection: 'flat', projections: modes(false) })).toBe(false);
  });
});

describe('createOrbit', () => {
  it('promotes flat to tilt, drags by elapsed time, clamps stalls, and reports transitions', () => {
    const onChange = vi.fn();
    const net = target('flat');
    const driver = createOrbit(net, onChange);

    driver.advance(50); // inactive: nothing moves
    expect(driver.active).toBe(false);
    expect(driver.start()).toBe(true);
    expect(driver.start()).toBe(true); // idempotent
    expect(net.projection).toBe('tilt');
    expect(driver.active).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);

    driver.advance(100); // first frame only anchors time
    expect(net.rotateBy).not.toHaveBeenCalled();
    driver.advance(116);
    expect(net.rotateBy).toHaveBeenLastCalledWith(0.32, 0);
    driver.advance(1000); // an 884 ms stall advances as 50 ms
    expect(net.rotateBy).toHaveBeenLastCalledWith(expect.closeTo(1, 6), 0);

    driver.stop();
    driver.advance(1016);
    expect(driver.active).toBe(false);
    expect(net.rotateBy).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
    driver.stop(); // idempotent
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('declines to start when no 3D projection is available', () => {
    const onChange = vi.fn();
    const net = target('flat', { tilt: false, globe: false });
    const driver = createOrbit(net, onChange);

    expect(driver.start()).toBe(false);
    expect(driver.active).toBe(false);
    expect(net.projection).toBe('flat');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drifts globe longitude at its rate and re-anchors time on restart', () => {
    const net = target('globe');
    const driver = createOrbit(net, vi.fn(), () => 2);

    expect(driver.start()).toBe(true);
    expect(net.setProjection).not.toHaveBeenCalled(); // globe keeps its projection
    driver.advance(10);
    driver.stop();

    driver.start();
    driver.advance(500); // anchors again: no drift from the stale 10 ms timestamp
    expect(net.setPose).not.toHaveBeenCalled();
    driver.advance(516);
    expect(net.setPose).toHaveBeenCalledExactlyOnceWith({ centerX: -89.744 }, true);
    expect(net.rotateBy).not.toHaveBeenCalled();
  });

  it('accepts zero as the first frame timestamp', () => {
    const net = target('tilt');
    const driver = createOrbit(net, vi.fn());

    driver.start();
    driver.advance(0);
    driver.advance(16);

    expect(net.rotateBy).toHaveBeenCalledExactlyOnceWith(0.32, 0);
  });
});
