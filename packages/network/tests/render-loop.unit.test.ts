import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderLoop } from '../src/webgpu/render-loop.js';
import { createUniforms } from '../src/webgpu/uniforms.js';
import type { Camera } from '../src/camera/camera.js';
import type { Renderer } from '../src/webgpu/renderer.js';

// ── rAF / DOM harness ─────────────────────────────────────────
// The loop's scheduling contract is exactly what these tests pin down, so
// rAF is a hand-pumped queue: frame() runs one browser frame's callbacks.

let rafPending = new Map<number, FrameRequestCallback>();
let nextRafId = 1;
let roCallback: ((entries?: ResizeObserverEntry[]) => void) | null = null;

beforeEach(() => {
  rafPending = new Map();
  nextRafId = 1;
  roCallback = null;
  vi.stubGlobal('window', { visualViewport: undefined });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafPending.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafPending.delete(id);
  });
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: (entries?: ResizeObserverEntry[]) => void) {
        roCallback = cb;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
});

/** An RO entry carrying only the device-pixel box, like a real observation. */
function roEntry(inlineSize: number, blockSize: number): ResizeObserverEntry {
  return {
    devicePixelContentBoxSize: [{ inlineSize, blockSize }],
  } as unknown as ResizeObserverEntry;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run one browser frame: every currently-pending rAF callback, once. */
function frame(): void {
  const callbacks = [...rafPending.values()];
  rafPending.clear();
  const t = performance.now();
  for (const cb of callbacks) cb(t);
}

/** Drain microtasks (queueMicrotask callbacks run before timers). */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  loop: RenderLoop;
  canvas: { clientWidth: number; clientHeight: number; width: number; height: number };
  renders: string[];
  cameraInits: Array<{ bounds: unknown; vp: { w: number; h: number } }>;
  setAnimating(v: boolean): void;
  fireResize(entries?: ResizeObserverEntry[]): void;
}

function makeHarness(
  opts: {
    onFrame?: () => void;
    onBeforeFrame?: (vp: { w: number; h: number }) => void;
    onPaint?: () => void;
    render?: () => boolean;
  } = {},
): Harness {
  const canvas = { clientWidth: 200, clientHeight: 100, width: 0, height: 0 };
  const uniforms = createUniforms();
  const renders: string[] = [];
  const cameraInits: Array<{ bounds: unknown; vp: { w: number; h: number } }> = [];
  const renderer = {
    render: () => {
      renders.push('render');
      return opts.render?.() ?? true;
    },
  } as unknown as Renderer;
  let animating = false;
  const camera = {
    fitIntent: false,
    init: (nextBounds: unknown, nextVp: { w: number; h: number }) => {
      cameraInits.push({ bounds: nextBounds, vp: { ...nextVp } });
    },
    tick: () => {},
    isAtFitView: () => false,
    isAnimating: () => animating,
  } as unknown as Camera;
  const bounds = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

  const loop = new RenderLoop({
    canvas: canvas as unknown as HTMLCanvasElement,
    uniforms,
    renderer,
    onFrame: opts.onFrame,
    onBeforeFrame: opts.onBeforeFrame,
    onPaint: opts.onPaint,
  });
  loop.setCamera(camera);
  loop.setBounds(bounds);

  return {
    loop,
    canvas,
    renders,
    cameraInits,
    setAnimating: (v) => {
      animating = v;
    },
    fireResize: (entries) => roCallback?.(entries),
  };
}

describe('RenderLoop scheduling', () => {
  it('a wake during the guard window upgrades it to an unconditional frame', () => {
    const h = makeHarness();
    h.loop.frameNow();
    expect(h.renders.length).toBe(1);

    h.loop.wake();
    frame();
    expect(h.renders.length).toBe(2);
  });

  it('frameNow cancels a queued rAF and renders immediately', () => {
    const h = makeHarness();
    h.loop.wake();
    const queued = [...rafPending.keys()][0];

    h.loop.frameNow();

    expect(h.renders.length).toBe(1);
    expect(rafPending.has(queued!)).toBe(false);
  });

  it('animation chains full frames and ends with one skipped guard', () => {
    const h = makeHarness();
    h.setAnimating(true);
    h.loop.wake();
    frame();
    frame();
    frame();
    expect(h.renders.length).toBe(3);

    h.setAnimating(false);
    frame(); // final animation frame renders, then arms the guard
    expect(h.renders.length).toBe(4);
    frame(); // guard: clean → quiet
    expect(h.renders.length).toBe(4);
    expect(rafPending.size).toBe(0);
  });

  it('invokes the frame hook before the render of the same frame', () => {
    const order: string[] = [];
    const h = makeHarness({ onFrame: () => order.push('hook') });
    const renders = h.renders; // renderer pushes 'render'
    h.loop.wake();
    frame();
    expect(renders.length).toBe(1);
    expect(order).toEqual(['hook']);
  });

  it('resize re-renders before the same paint even after a render, quantized then snapped', async () => {
    const h = makeHarness();
    h.loop.frameNow();
    expect(h.renders.length).toBe(1);
    expect(h.canvas.width).toBe(200); // first sighting sizes exactly

    // The panel rail drags: RO fires after this frame's rAF phase.
    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(h.renders.length).toBe(2); // same-frame contract
    expect(h.canvas.width).toBe(256); // quantized while the gesture is live
    expect(h.canvas.height).toBe(128);

    frame(); // stable 1
    frame(); // stable 2
    frame(); // stable 3 → settled → snap to exact
    expect(h.canvas.width).toBe(210);
    expect(h.canvas.height).toBe(100);

    frame(); // trailing guard goes quiet
    expect(rafPending.size).toBe(0);
  });

  it('falls back when device-pixel ResizeObserver observation is unsupported', () => {
    const observeOptions: unknown[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (entries?: ResizeObserverEntry[]) => void) {
          roCallback = cb;
        }
        observe(_target: Element, options?: ResizeObserverOptions): void {
          observeOptions.push(options);
          if (observeOptions.length === 1) throw new Error('unsupported box');
        }
        disconnect(): void {}
      },
    );

    makeHarness();

    expect(observeOptions).toEqual([{ box: 'device-pixel-content-box' }, undefined]);
  });

  it('wires visualViewport resize into same-frame flush and removes the handler', async () => {
    let handler: (() => void) | null = null;
    const visualViewport = {
      addEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) => {
        handler = cb as () => void;
      }),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'visualViewport', {
      value: visualViewport,
      configurable: true,
    });

    const h = makeHarness();
    h.loop.frameNow();
    h.canvas.clientWidth = 220;
    const resize = handler as (() => void) | null;
    if (!resize) throw new Error('visualViewport resize handler was not registered');
    resize();
    await drain();

    expect(h.renders.length).toBe(2);
    h.loop.destroy();
    expect(visualViewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith('resize', resize);
  });

  it('a mid-gesture size change stays within one quantum bucket without reallocating', async () => {
    const h = makeHarness();
    h.loop.frameNow();

    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(h.canvas.width).toBe(256);

    // 210 → 240 stays inside the 256 bucket: no backing-store change.
    h.canvas.clientWidth = 240;
    h.fireResize();
    await drain();
    expect(h.canvas.width).toBe(256);
  });

  it('survives a destroy issued from the frame hook', () => {
    // The onFrame hook runs host callbacks (onHover) mid-tick; a host may
    // tear the session down from one. The tick must bail before submitting.
    let loop: RenderLoop | null = null;
    const h = makeHarness({ onFrame: () => loop?.destroy() });
    loop = h.loop;

    h.loop.wake();
    frame();
    expect(h.renders.length).toBe(0); // hook killed the frame pre-submit
    expect(rafPending.size).toBe(0); // and nothing was rescheduled
  });

  it('prefers ResizeObserver device-pixel sizes over layout reads', async () => {
    const h = makeHarness();
    h.loop.frameNow();
    expect(h.canvas.width).toBe(200); // first sighting via the layout fallback

    // The RO reports exact device pixels; clientWidth is never consulted
    // again (leave it stale to prove it).
    h.canvas.clientWidth = 9999;
    h.fireResize([roEntry(210, 100)]);
    await drain();
    expect(h.canvas.width).toBe(256); // quantized during the gesture

    frame();
    frame();
    frame(); // settle → snap to the RO-exact size
    expect(h.canvas.width).toBe(210);
    expect(h.canvas.height).toBe(100);
  });

  it('pause cancels pending frames; resume renders again', async () => {
    const h = makeHarness();
    h.loop.wake();
    expect(rafPending.size).toBe(1);

    h.loop.pause();
    expect(rafPending.size).toBe(0);
    h.loop.wake();
    expect(rafPending.size).toBe(0); // paused

    h.loop.resume();
    frame();
    expect(h.renders.length).toBe(1);
  });

  it('applies pending fit before ticking and submitting the frame', () => {
    const order: string[] = [];
    const h = makeHarness({
      onBeforeFrame: () => order.push('beforeFrame'),
      render: () => {
        order.push('render');
        return true;
      },
    });

    h.loop.requestFit();
    h.loop.frameNow();

    expect(h.cameraInits).toEqual([
      { bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }, vp: { w: 200, h: 100 } },
    ]);
    expect(order).toEqual(['beforeFrame', 'render']);
  });
});
