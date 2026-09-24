/// <reference types="@webgpu/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFrameLoop, type Frame, type FrameLoop, type Presentation } from '../src/index.js';
import { observeCanvas } from '../src/presentation.js';

// The loop's scheduling contract is exactly what these tests pin down, so rAF is a hand-pumped
// queue: `paint()` runs one browser frame's callbacks.

let rafPending = new Map<number, FrameRequestCallback>();
let nextRafId = 1;
let roCallback: ((entries: ResizeObserverEntry[]) => void) | null = null;
let disconnects = 0;

class FakeResizeObserver {
  constructor(callback: (entries: ResizeObserverEntry[]) => void) {
    roCallback = callback;
  }
  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  disconnect(): void {
    disconnects++;
  }
}

beforeEach(() => {
  rafPending = new Map();
  nextRafId = 1;
  roCallback = null;
  disconnects = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextRafId++;
    rafPending.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafPending.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run one browser frame: every currently pending rAF callback, once. */
function paint(): void {
  const callbacks = [...rafPending.values()];
  rafPending.clear();
  const now = performance.now();
  for (const callback of callbacks) callback(now);
}

/** Let queued microtasks run. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A resize observation carrying only the device-pixel box, like a real one. */
function deviceBox(inlineSize: number, blockSize: number): ResizeObserverEntry {
  return {
    devicePixelContentBoxSize: [{ inlineSize, blockSize }],
  } as unknown as ResizeObserverEntry;
}

interface Harness {
  readonly loop: FrameLoop;
  readonly canvas: { clientWidth: number; clientHeight: number; width: number; height: number };
  /** A copy of every frame `render` saw, in order. */
  readonly frames: Frame[];
  /** The frame object itself, per call, to check reuse. */
  readonly identities: Frame[];
  readonly resize: ReturnType<typeof vi.fn>;
  fireResize(entries?: ResizeObserverEntry[]): void;
}

function makeHarness(
  options: {
    render?: (frame: Frame) => boolean;
    pixelRatio?: number;
    /** The device's 2D texture limit, as `Presentation.resize` applies it. */
    limit?: number;
    clientWidth?: number;
    view?: Record<string, unknown>;
    /** The loop's `quantize` option; omitted, the loop gets no options at all. */
    quantize?: boolean;
  } = {},
): Harness {
  const canvas = {
    clientWidth: options.clientWidth ?? 200,
    clientHeight: 100,
    width: 0,
    height: 0,
    ownerDocument: {
      defaultView: {
        devicePixelRatio: options.pixelRatio ?? 1,
        ResizeObserver: FakeResizeObserver,
        ...options.view,
      },
    },
  };
  const resize = vi.fn((width: number, height: number) => {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const scale = Math.min(1, limit / width, limit / height);
    const nextWidth = Math.max(1, Math.floor(width * scale));
    const nextHeight = Math.max(1, Math.floor(height * scale));
    const changed = canvas.width !== nextWidth || canvas.height !== nextHeight;
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    return changed;
  });
  const element = canvas as unknown as HTMLCanvasElement;
  const presentation = {
    canvas: element,
    device: {} as GPUDevice,
    context: { canvas } as unknown as GPUCanvasContext,
    format: 'bgra8unorm',
    resize,
    // The real observation, so the loop is tested against what a presentation reports.
    observe: (listener) => observeCanvas(element, listener),
    destroy: vi.fn(),
  } satisfies Presentation<HTMLCanvasElement>;

  const frames: Frame[] = [];
  const identities: Frame[] = [];
  const loop = createFrameLoop(
    presentation,
    (frame) => {
      frames.push({ ...frame });
      identities.push(frame);
      return options.render?.(frame) ?? false;
    },
    options.quantize === undefined ? undefined : { quantize: options.quantize },
  );

  return {
    loop,
    canvas,
    frames,
    identities,
    resize,
    fireResize: (entries) => roCallback?.(entries ?? []),
  };
}

describe('createFrameLoop scheduling', () => {
  it('renders nothing on the synchronous first report', async () => {
    const h = makeHarness();
    await drain();

    expect(rafPending.size).toBe(0);
    expect(h.frames).toHaveLength(0);
  });

  it("renders the observer's initial notification unwoken, like any later size report", async () => {
    // A browser's ResizeObserver always delivers one notification after `observe`, in the next
    // rendering step, even when the size never changes.
    class NotifyingObserver extends FakeResizeObserver {
      override observe(_target: Element, _options?: ResizeObserverOptions): void {
        const deliver = roCallback;
        queueMicrotask(() => deliver?.([deviceBox(200, 100)]));
      }
    }
    const h = makeHarness({ view: { ResizeObserver: NotifyingObserver } });
    expect(h.frames).toHaveLength(0);

    await drain();

    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ width: 200, height: 100, settled: true });
    expect(h.canvas.width).toBe(200);
    expect(rafPending.size).toBe(0);
  });

  it('coalesces repeated wakes into one frame', () => {
    const h = makeHarness();

    h.loop.wake();
    h.loop.wake();
    h.loop.wake();
    expect(rafPending.size).toBe(1);

    paint();
    expect(h.frames).toHaveLength(1);
  });

  it('frameNow cancels a queued frame and renders immediately', () => {
    const h = makeHarness();
    h.loop.wake();
    const queued = [...rafPending.keys()][0];

    h.loop.frameNow();

    expect(h.frames).toHaveLength(1);
    expect(rafPending.has(queued!)).toBe(false);
    paint();
    expect(h.frames).toHaveLength(1);
  });

  it('chains frames while render returns true and stops when it returns false', () => {
    let again = true;
    const h = makeHarness({ render: () => again });

    h.loop.wake();
    paint();
    paint();
    paint();
    expect(h.frames).toHaveLength(3);
    expect(rafPending.size).toBe(1);

    again = false;
    paint(); // the last frame renders and schedules nothing: there is no trailing guard
    expect(h.frames).toHaveLength(4);
    expect(rafPending.size).toBe(0);
  });

  it('schedules one next frame when render wakes the loop, never two', () => {
    let loop: FrameLoop | null = null;
    const h = makeHarness({
      render: () => {
        loop?.wake();
        loop?.wake();
        return true;
      },
    });
    loop = h.loop;

    h.loop.frameNow();

    expect(rafPending.size).toBe(1);
    paint();
    expect(h.frames).toHaveLength(2);
    expect(rafPending.size).toBe(1);
  });

  it('hands render the tick time, the CSS size, the backing scale, and settledness', () => {
    const h = makeHarness({ pixelRatio: 2 });

    h.loop.frameNow();

    expect(h.frames[0]!.now).toBeGreaterThan(0);
    expect(h.frames[0]).toMatchObject({ width: 200, height: 100, backingScale: 2, settled: true });
    expect(h.canvas.width).toBe(400);
    expect(h.canvas.height).toBe(200);
  });

  it('reuses one frame object for every frame', () => {
    const h = makeHarness({ render: () => true });

    h.loop.frameNow();
    paint();
    paint();

    expect(h.identities).toHaveLength(3);
    expect(new Set(h.identities).size).toBe(1);
    expect(h.frames[2]!.now).toBeGreaterThanOrEqual(h.frames[0]!.now);
  });

  it('skips a frame without area and schedules nothing until a resize gives it area', async () => {
    const h = makeHarness({ clientWidth: 0, render: () => true });

    h.loop.wake();
    paint();
    h.loop.frameNow();
    expect(h.frames).toHaveLength(0);
    expect(rafPending.size).toBe(0);
    expect(h.resize).not.toHaveBeenCalled();

    h.canvas.clientWidth = 200;
    h.fireResize();
    await drain();
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ width: 200, height: 100, settled: true });
  });
});

describe('createFrameLoop resize', () => {
  it('re-renders before the same paint, quantized while resizing, then snaps exact', async () => {
    const h = makeHarness();
    h.loop.frameNow();
    expect(h.frames).toHaveLength(1);
    expect(h.canvas.width).toBe(200); // the first sighting sizes exactly

    // A panel rail drags: the observation lands after this frame's rAF phase.
    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(h.frames).toHaveLength(2); // the same-paint contract
    expect(h.frames[1]).toMatchObject({ width: 210, height: 100, settled: false });
    expect(h.canvas.width).toBe(256); // quantized while the resize is in flight
    expect(h.canvas.height).toBe(128);
    expect(h.frames[1]!.backingScale).toBeCloseTo(256 / 210, 6);

    paint(); // stable 1
    paint(); // stable 2
    paint(); // stable 3: settled, snap exact
    expect(h.canvas.width).toBe(210);
    expect(h.canvas.height).toBe(100);
    expect(h.frames.at(-1)).toMatchObject({ settled: true, backingScale: 1 });

    // An unsettled size keeps frames coming though render returned false; settled, it stops.
    expect(h.frames).toHaveLength(5);
    expect(rafPending.size).toBe(0);
  });

  it('sizes the backing store exactly on every frame when quantize is off', async () => {
    const h = makeHarness({ quantize: false });
    h.loop.frameNow();
    expect(h.canvas.width).toBe(200);

    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1]).toMatchObject({ width: 210, height: 100, backingScale: 1, settled: true });
    expect([h.canvas.width, h.canvas.height]).toEqual([210, 100]);
    // Settled at once: no settle frames follow, so the resize reallocated once.
    expect(rafPending.size).toBe(0);
    expect(h.resize.mock.calls).toEqual([
      [200, 100],
      [210, 100],
    ]);

    // Each further step follows exactly, where a quantizing loop would stay in its 256 bucket.
    h.canvas.clientWidth = 240;
    h.fireResize();
    await drain();
    expect(h.canvas.width).toBe(240);
    expect(h.frames.at(-1)).toMatchObject({ width: 240, settled: true });
    expect(h.resize).toHaveBeenCalledTimes(3);
    expect(rafPending.size).toBe(0);
  });

  it('quantizes by default and when asked', async () => {
    for (const quantize of [undefined, true]) {
      const h = makeHarness({ quantize });
      h.loop.frameNow();
      h.canvas.clientWidth = 210;
      h.fireResize();
      await drain();
      expect(h.frames.at(-1)).toMatchObject({ width: 210, settled: false });
      expect(h.canvas.width).toBe(256);
      h.loop.destroy();
    }
  });

  it('cancels a queued frame when a resize flushes', async () => {
    const h = makeHarness();
    h.loop.frameNow();
    h.loop.wake();
    const queued = [...rafPending.keys()][0];

    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(h.frames).toHaveLength(2);

    // The flush replaced the queued frame; only the settle frame it scheduled remains.
    expect(rafPending.has(queued!)).toBe(false);
    expect(rafPending.size).toBe(1);
  });

  it('coalesces resizes within one task into one flush', async () => {
    const h = makeHarness();
    h.loop.frameNow();

    h.canvas.clientWidth = 210;
    h.fireResize();
    h.canvas.clientWidth = 220;
    h.fireResize();
    await drain();

    expect(h.frames).toHaveLength(2);
    expect(h.frames[1]!.width).toBe(220);
  });

  it('keeps the backing store within one quantum bucket through a resize', async () => {
    const h = makeHarness();
    h.loop.frameNow();

    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(h.canvas.width).toBe(256);
    const requests = h.resize.mock.calls.length;

    // 210 to 240 stays inside the 256 bucket: no backing-store change.
    h.canvas.clientWidth = 240;
    h.fireResize();
    await drain();
    expect(h.canvas.width).toBe(256);
    expect(h.resize.mock.calls.length).toBe(requests);
  });

  it('prefers observed device-pixel sizes over layout reads', async () => {
    const h = makeHarness();
    h.loop.frameNow();
    expect(h.canvas.width).toBe(200); // the first sighting, from layout

    // The observation reports exact device pixels; clientWidth is never consulted again (leave it
    // stale to prove it).
    h.canvas.clientWidth = 9999;
    h.fireResize([deviceBox(210, 100)]);
    await drain();
    expect(h.canvas.width).toBe(256);

    paint();
    paint();
    paint();
    expect(h.canvas.width).toBe(210);
    expect(h.canvas.height).toBe(100);
  });

  it('keeps CSS size and requests the backing size once when the device limits it', () => {
    const h = makeHarness({ pixelRatio: 2, limit: 256 });

    h.loop.frameNow();
    h.loop.frameNow();

    expect(h.canvas.width).toBe(256);
    expect(h.canvas.height).toBe(128);
    expect(h.frames[0]).toMatchObject({ width: 200, height: 100 });
    expect(h.frames[0]!.backingScale).toBeCloseTo(1.28, 6);
    expect(h.resize).toHaveBeenCalledOnce();
    expect(h.resize).toHaveBeenCalledWith(400, 200);
  });

  it('flushes resizes a fallback observation reports and stops it on destroy', async () => {
    const observeOptions: unknown[] = [];
    class ContentBoxOnly extends FakeResizeObserver {
      override observe(_target: Element, options?: ResizeObserverOptions): void {
        observeOptions.push(options);
        if (observeOptions.length === 1) throw new Error('unsupported box');
      }
    }
    let viewportResize: (() => void) | null = null;
    const visualViewport = {
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        viewportResize = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const h = makeHarness({ view: { ResizeObserver: ContentBoxOnly, visualViewport } });
    expect(observeOptions).toEqual([{ box: 'device-pixel-content-box' }, undefined]);

    h.loop.frameNow();
    h.canvas.clientWidth = 220;
    const report = viewportResize as (() => void) | null;
    if (!report) throw new Error('the visualViewport resize listener was not registered');
    report();
    await drain();
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1]!.width).toBe(220);

    h.loop.destroy();
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith('resize', report);
  });
});

describe('createFrameLoop pause and destroy', () => {
  it('pause cancels a queued frame and drops wakes, frames and resizes; resume renders', async () => {
    const h = makeHarness();
    h.loop.frameNow();
    h.loop.wake();
    expect(rafPending.size).toBe(1);

    h.loop.pause();
    expect(rafPending.size).toBe(0);
    h.loop.wake();
    h.loop.frameNow();
    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(rafPending.size).toBe(0);
    expect(h.frames).toHaveLength(1);

    h.loop.resume();
    expect(rafPending.size).toBe(1);
    paint();
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1]!.width).toBe(210); // the size that changed while paused
  });

  it('stops when render pauses the loop, though it asked for another frame', () => {
    let loop: FrameLoop | null = null;
    const h = makeHarness({
      render: () => {
        loop?.pause();
        return true;
      },
    });
    loop = h.loop;

    h.loop.wake();
    paint();
    expect(h.frames).toHaveLength(1);
    expect(rafPending.size).toBe(0);
  });

  it('stops when render destroys the loop, though it asked for another frame', () => {
    let loop: FrameLoop | null = null;
    const h = makeHarness({
      render: () => {
        loop?.destroy();
        return true;
      },
    });
    loop = h.loop;

    h.loop.wake();
    paint();
    expect(h.frames).toHaveLength(1);
    expect(rafPending.size).toBe(0);
    expect(disconnects).toBe(1);
  });

  it('destroy is idempotent, stops observation, and drops everything after it', async () => {
    const h = makeHarness();
    h.loop.wake();

    h.loop.destroy();
    h.loop.destroy();
    expect(disconnects).toBe(1);
    expect(rafPending.size).toBe(0);

    h.loop.wake();
    h.loop.frameNow();
    h.loop.resume();
    h.canvas.clientWidth = 210;
    h.fireResize();
    await drain();
    expect(rafPending.size).toBe(0);
    expect(h.frames).toHaveLength(0);
  });

  it('drops a resize flush already queued when the loop is destroyed', async () => {
    const h = makeHarness();
    h.loop.frameNow();

    h.canvas.clientWidth = 210;
    h.fireResize();
    h.loop.destroy();
    await drain();

    expect(h.frames).toHaveLength(1);
    expect(rafPending.size).toBe(0);
  });
});
