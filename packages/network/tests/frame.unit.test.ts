import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameLoop, type Frame, type Presentation } from '@latkit/gpu';

import { createFrameTick, type FrameTickDeps } from '../src/webgpu/frame.js';
import { createUniforms } from '../src/webgpu/uniforms.js';
import type { Viewport } from '../src/camera/projection.js';

interface Harness {
  readonly tick: (frame: Frame) => boolean;
  readonly uniforms: ReturnType<typeof createUniforms>;
  readonly canvas: { width: number; height: number };
  readonly order: string[];
  readonly viewports: Viewport[];
  readonly state: {
    loaded: boolean;
    animating: boolean;
    pendingPlacement: boolean;
    atFit: boolean;
    painted: boolean;
    outside: boolean;
    live: boolean;
  };
}

function makeHarness(overrides: Partial<FrameTickDeps> = {}): Harness {
  const canvas = { width: 400, height: 200 };
  const uniforms = createUniforms();
  const order: string[] = [];
  const viewports: Viewport[] = [];
  const state = {
    loaded: true,
    animating: false,
    pendingPlacement: false,
    atFit: true,
    painted: true,
    outside: false,
    live: true,
  };
  const tick = createFrameTick({
    canvas: canvas as unknown as HTMLCanvasElement,
    uniforms,
    renderer: {
      render: () => {
        order.push('render');
        return state.painted;
      },
    },
    rig: {
      tick: (_now: number, vp: Viewport) => {
        order.push('rig');
        viewports.push(vp);
        return state.loaded;
      },
      isAnimating: () => state.animating,
      isAtFitView: () => state.atFit,
      get pendingPlacement() {
        return state.pendingPlacement;
      },
    },
    onBeforeFrame: () => order.push('before'),
    onZoom: (fit) => order.push(`zoom:${String(fit)}`),
    onFrame: (settled) => order.push(`frame:${String(settled)}`),
    onPaint: () => order.push('paint'),
    animating: () => state.outside,
    live: () => state.live,
    ...overrides,
  });
  return { tick, uniforms, canvas, order, viewports, state };
}

function frameOf(fields: Partial<Frame> = {}): Frame {
  return { now: 16, width: 200, height: 100, backingScale: 2, settled: true, ...fields };
}

describe('createFrameTick', () => {
  it('ticks the rig with the CSS viewport, then derives, picks, submits, and paints', () => {
    const h = makeHarness();

    expect(h.tick(frameOf({ settled: false }))).toBe(false);

    expect(h.order).toEqual(['rig', 'before', 'frame:false', 'render', 'paint']);
    expect(h.viewports[0]).toEqual({ w: 200, h: 100 });
  });

  it('writes the backing size after visual derivation and before picking', () => {
    const seen: Array<[string, number, number]> = [];
    const capture = (phase: string): void => {
      seen.push([phase, h.uniforms.frame.backingScale, h.uniforms.frame.viewportX]);
    };
    const h = makeHarness({
      onBeforeFrame: () => capture('before'),
      onFrame: () => capture('frame'),
    });
    h.uniforms.frame.backingScale = 7;

    h.tick(frameOf({ backingScale: 1.28 }));

    expect(seen[0]).toEqual(['before', 7, 0]);
    expect(seen[1]![0]).toBe('frame');
    expect(seen[1]![1]).toBeCloseTo(1.28, 6);
    expect(seen[1]![2]).toBe(400);
    expect(h.uniforms.frame.viewportY).toBe(200);
  });

  it('skips the frame and asks for nothing while no scene is loaded', () => {
    const h = makeHarness();
    h.state.loaded = false;
    h.state.animating = true;

    expect(h.tick(frameOf())).toBe(false);
    expect(h.order).toEqual(['rig']);
  });

  it('reports fit-view transitions only when they change', () => {
    const h = makeHarness();
    h.tick(frameOf());
    h.state.atFit = false;
    h.tick(frameOf());
    h.tick(frameOf());
    h.state.atFit = true;
    h.tick(frameOf());

    expect(h.order.filter((step) => step.startsWith('zoom'))).toEqual(['zoom:false', 'zoom:true']);
    // The notice lands after visual derivation and before hover resolution.
    const second = h.order.slice(5, 10);
    expect(second).toEqual(['rig', 'before', 'zoom:false', 'frame:true', 'render']);
  });

  it('stops before the submit when a hook ended the view', () => {
    const h = makeHarness({
      onBeforeFrame: () => {
        h.order.push('before');
        h.state.live = false;
      },
    });
    h.state.animating = true;

    expect(h.tick(frameOf())).toBe(false);
    expect(h.order).toEqual(['rig', 'before', 'frame:true']);
  });

  it('paints only after a submit the renderer accepted', () => {
    const h = makeHarness();
    h.state.painted = false;

    h.tick(frameOf());

    expect(h.order).toEqual(['rig', 'before', 'frame:true', 'render']);
  });

  it.each([
    ['camera easing', 'animating'],
    ['deferred placement', 'pendingPlacement'],
    ['an outside animator', 'outside'],
  ] as const)('asks for another frame during %s', (_name, key) => {
    const h = makeHarness();
    expect(h.tick(frameOf())).toBe(false);
    h.state[key] = true;
    expect(h.tick(frameOf())).toBe(true);
  });

  it('reuses one viewport across frames', () => {
    const h = makeHarness();
    h.tick(frameOf());
    h.tick(frameOf({ width: 300, height: 150 }));

    expect(h.viewports[0]).toBe(h.viewports[1]);
    expect(h.viewports[1]).toEqual({ w: 300, h: 150 });
  });
});

describe('createFrameTick on the shared frame loop', () => {
  let pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;

  beforeEach(() => {
    pending = new Map();
    nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pending.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Run one browser frame: every pending callback, once. */
  function pump(): void {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(performance.now());
  }

  function drive(h: Harness): ReturnType<typeof createFrameLoop> {
    const canvas = h.canvas as unknown as HTMLCanvasElement;
    const presentation = {
      canvas,
      device: {} as GPUDevice,
      context: {} as GPUCanvasContext,
      format: 'bgra8unorm',
      resize: vi.fn((width: number, height: number) => {
        h.canvas.width = width;
        h.canvas.height = height;
        return true;
      }),
      observe: (listener: (width: number, height: number, pixelRatio: number) => void) => {
        listener(200, 100, 1);
        return () => {};
      },
      destroy: vi.fn(),
    } satisfies Presentation<HTMLCanvasElement>;
    return createFrameLoop(presentation, h.tick);
  }

  it('keeps framing while placement is deferred, then goes quiet without a trailing frame', () => {
    const h = makeHarness();
    const loop = drive(h);
    h.state.pendingPlacement = true;

    loop.wake();
    pump();
    pump();
    expect(h.order.filter((step) => step === 'render')).toHaveLength(2);

    h.state.pendingPlacement = false;
    pump();
    expect(h.order.filter((step) => step === 'render')).toHaveLength(3);
    expect(pending.size).toBe(0);
    loop.destroy();
  });

  it('chains animation frames and stops on the first still one', () => {
    const h = makeHarness();
    const loop = drive(h);
    h.state.outside = true;

    loop.frameNow();
    pump();
    h.state.outside = false;
    pump();

    expect(h.order.filter((step) => step === 'render')).toHaveLength(3);
    expect(pending.size).toBe(0);
    loop.destroy();
  });

  it('schedules nothing after a hook paused the loop mid-frame', () => {
    const h = makeHarness({
      onBeforeFrame: () => {
        h.state.live = false;
        loop.pause();
      },
    });
    const loop = drive(h);
    h.state.animating = true;

    loop.wake();
    pump();

    expect(h.order).not.toContain('render');
    expect(pending.size).toBe(0);
    loop.destroy();
  });
});
