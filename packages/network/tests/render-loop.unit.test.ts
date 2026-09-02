import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Presentation } from '@latkit/gpu';

import { RenderLoop } from '../src/webgpu/render-loop.js';
import { createUniforms } from '../src/webgpu/uniforms.js';
import type { CameraRig } from '../src/camera/rig.js';
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
  uniforms: ReturnType<typeof createUniforms>;
  canvas: { clientWidth: number; clientHeight: number; width: number; height: number };
  renders: string[];
  rigTicks: Array<{ now: number; vp: { w: number; h: number } }>;
  resize: ReturnType<typeof vi.fn>;
  setAnimating(v: boolean): void;
  setPendingPlacement(v: boolean): void;
  fireResize(entries?: ResizeObserverEntry[]): void;
}

function makeHarness(
  opts: {
    onFrame?: () => void;
    onBeforeFrame?: (vp: { w: number; h: number }) => void;
    onPaint?: () => void;
    onRigTick?: () => void;
    render?: () => boolean;
    pixelRatio?: number;
    limit?: number;
    visualViewport?: VisualViewport;
  } = {},
): Harness {
  const canvas = {
    clientWidth: 200,
    clientHeight: 100,
    width: 0,
    height: 0,
    ownerDocument: {
      defaultView: {
        devicePixelRatio: opts.pixelRatio ?? 1,
        ResizeObserver,
        visualViewport: opts.visualViewport,
      },
    },
  };
  const uniforms = createUniforms();
  const renders: string[] = [];
  const rigTicks: Harness['rigTicks'] = [];
  const renderer = {
    render: () => {
      renders.push('render');
      return opts.render?.() ?? true;
    },
  } as unknown as Renderer;
  const resize = vi.fn((width: number, height: number) => {
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    const scale = Math.min(1, limit / width, limit / height);
    const nextWidth = Math.max(1, Math.floor(width * scale));
    const nextHeight = Math.max(1, Math.floor(height * scale));
    const changed = canvas.width !== nextWidth || canvas.height !== nextHeight;
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    return changed;
  });
  // Mirrors the gpu package's HTML canvas observation: a device-pixel
  // ResizeObserver with plain-box fallback, visualViewport resizes, and an
  // initial layout-derived report.
  const observe = (listener: (width: number, height: number, pixelRatio: number) => void) => {
    const view = canvas.ownerDocument.defaultView;
    const report = (entry?: ResizeObserverEntry): void => {
      const ratio = view.devicePixelRatio;
      const box = entry?.devicePixelContentBoxSize?.[0];
      if (box) listener(box.inlineSize, box.blockSize, ratio);
      else {
        listener(
          Math.round(canvas.clientWidth * ratio),
          Math.round(canvas.clientHeight * ratio),
          ratio,
        );
      }
    };
    const observer = new view.ResizeObserver((entries) => report(entries[entries.length - 1]));
    try {
      observer.observe(canvas as unknown as Element, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(canvas as unknown as Element);
    }
    const onViewportResize = (): void => report();
    view.visualViewport?.addEventListener('resize', onViewportResize);
    report();
    return () => {
      observer.disconnect();
      view.visualViewport?.removeEventListener('resize', onViewportResize);
    };
  };
  const presentation = {
    canvas: canvas as unknown as HTMLCanvasElement,
    device: {} as GPUDevice,
    context: { canvas } as unknown as GPUCanvasContext,
    format: 'bgra8unorm',
    resize,
    observe,
    destroy: vi.fn(),
  } satisfies Presentation<HTMLCanvasElement>;
  let animating = false;
  let pendingPlacement = false;
  const rig = {
    get pendingPlacement() {
      return pendingPlacement;
    },
    tick: (now: number, nextVp: { w: number; h: number }) => {
      rigTicks.push({ now, vp: { ...nextVp } });
      opts.onRigTick?.();
      return true;
    },
    isAtFitView: () => false,
    isAnimating: () => animating,
  } as unknown as CameraRig;

  const loop = new RenderLoop({
    presentation,
    uniforms,
    renderer,
    rig,
    onFrame: opts.onFrame,
    onBeforeFrame: opts.onBeforeFrame,
    onPaint: opts.onPaint,
  });

  return {
    loop,
    uniforms,
    canvas,
    renders,
    rigTicks,
    resize,
    setAnimating: (v) => {
      animating = v;
    },
    setPendingPlacement: (v) => {
      pendingPlacement = v;
    },
    fireResize: (entries) => roCallback?.(entries ?? []),
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

  it('updates presentation scale after visual derivation and before picking', () => {
    type Phase = 'before' | 'frame' | 'render';
    const observed: Array<{ phase: Phase; backingScale: number }> = [];
    // The callbacks only fire from frameNow() below, after `h` initializes.
    const capture = (phase: Phase): void => {
      observed.push({
        phase,
        backingScale: h.uniforms.frame.backingScale,
      });
    };
    const h = makeHarness({
      pixelRatio: 2,
      limit: 256,
      onBeforeFrame: () => capture('before'),
      onFrame: () => capture('frame'),
      render: () => {
        capture('render');
        return true;
      },
    });
    h.uniforms.frame.backingScale = 7;

    h.loop.frameNow();

    expect(observed.map(({ phase }) => phase)).toEqual(['before', 'frame', 'render']);
    expect(observed[0]).toEqual({ phase: 'before', backingScale: 7 });
    expect(observed[1]!.backingScale).toBeCloseTo(1.28, 6);
    expect(observed[2]!.phase).toBe('render');
    expect(observed[2]!.backingScale).toBeCloseTo(1.28, 6);
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
    const h = makeHarness({ visualViewport: visualViewport as unknown as VisualViewport });
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

  it('keeps CSS camera space and stable resize work when the backing size is limited', () => {
    const h = makeHarness({ pixelRatio: 2, limit: 256 });

    h.loop.frameNow();
    h.loop.frameNow();

    expect(h.canvas.width).toBe(256);
    expect(h.canvas.height).toBe(128);
    expect(h.rigTicks[0]?.vp).toEqual({ w: 200, h: 100 });
    expect(h.resize).toHaveBeenCalledOnce();
    expect(h.resize).toHaveBeenCalledWith(400, 200);
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

  it('ticks the rig with the CSS viewport before the frame hooks and the submit', () => {
    const order: string[] = [];
    const h = makeHarness({
      onRigTick: () => order.push('rig'),
      onBeforeFrame: () => order.push('beforeFrame'),
      render: () => {
        order.push('render');
        return true;
      },
    });

    h.loop.frameNow();

    expect(h.rigTicks).toHaveLength(1);
    expect(h.rigTicks[0]?.vp).toEqual({ w: 200, h: 100 });
    expect(h.rigTicks[0]?.now).toBeGreaterThan(0);
    expect(order).toEqual(['rig', 'beforeFrame', 'render']);
  });

  it('renders a trailing guard frame while the rig holds deferred placement', () => {
    const h = makeHarness();
    h.loop.frameNow(); // arms the trailing guard
    expect(h.renders.length).toBe(1);

    h.setPendingPlacement(true);
    frame(); // guard sees pending placement and renders
    expect(h.renders.length).toBe(2);

    h.setPendingPlacement(false);
    frame(); // subsequent guard goes quiet
    expect(h.renders.length).toBe(2);
    expect(rafPending.size).toBe(0);
  });
});
