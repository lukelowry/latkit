import { describe, expect, it, vi } from 'vitest';

import { canOrbit, createOrbit, type OrbitTarget } from '../src/orbit.js';
import type { Pose } from '../src/camera/projection.js';
import type { Projection } from '../src/projections.js';

/** A manual frame scheduler: `step(time)` runs the pending callback once. */
function scheduler() {
  let pending: FrameRequestCallback | null = null;
  let handle = 0;
  return {
    scheduleFrame: vi.fn((callback: FrameRequestCallback) => {
      pending = callback;
      return ++handle;
    }),
    cancelFrame: vi.fn(() => {
      pending = null;
    }),
    step(time: number) {
      const callback = pending;
      pending = null;
      callback?.(time);
    },
    get pending() {
      return pending !== null;
    },
  };
}

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
    const frames = scheduler();
    const onChange = vi.fn();
    const net = target('flat');
    const driver = createOrbit(net, onChange, frames);

    expect(driver.active).toBe(false);
    expect(driver.start()).toBe(true);
    expect(driver.start()).toBe(true); // idempotent
    expect(net.projection).toBe('tilt');
    expect(driver.active).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);

    frames.step(100); // first frame only anchors time
    expect(net.rotateBy).not.toHaveBeenCalled();
    frames.step(116);
    expect(net.rotateBy).toHaveBeenLastCalledWith(0.32, 0);
    frames.step(1000); // an 884 ms stall advances as 50 ms
    expect(net.rotateBy).toHaveBeenLastCalledWith(expect.closeTo(1, 6), 0);

    driver.stop();
    expect(driver.active).toBe(false);
    expect(frames.pending).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
    driver.stop(); // idempotent
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('declines to start when no 3D projection is available', () => {
    const frames = scheduler();
    const onChange = vi.fn();
    const net = target('flat', { tilt: false, globe: false });
    const driver = createOrbit(net, onChange, frames);

    expect(driver.start()).toBe(false);
    expect(driver.active).toBe(false);
    expect(net.projection).toBe('flat');
    expect(frames.scheduleFrame).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drifts globe longitude and re-anchors time on restart', () => {
    const frames = scheduler();
    const net = target('globe');
    const driver = createOrbit(net, vi.fn(), frames);

    expect(driver.start()).toBe(true);
    expect(net.setProjection).not.toHaveBeenCalled(); // globe keeps its projection
    frames.step(10);
    driver.stop();
    expect(frames.cancelFrame).toHaveBeenCalledOnce();

    driver.start();
    frames.step(500); // anchors again: no drift from the stale 10 ms timestamp
    expect(net.setPose).not.toHaveBeenCalled();
    frames.step(516);
    expect(net.setPose).toHaveBeenCalledExactlyOnceWith({ centerX: -89.872 }, true);
    expect(net.rotateBy).not.toHaveBeenCalled();
  });

  it('accepts zero as the first frame timestamp', () => {
    const frames = scheduler();
    const net = target('tilt');
    const driver = createOrbit(net, vi.fn(), frames);

    driver.start();
    frames.step(0);
    frames.step(16);

    expect(net.rotateBy).toHaveBeenCalledExactlyOnceWith(0.32, 0);
  });
});
