// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachGestures, type Gesture, type GesturePolicy } from '../src/input/gestures.js';
import type { Surface } from '../src/input/surface.js';

interface TestPointerEventInit extends PointerEventInit {
  coalesced?: PointerEvent[];
  timeStamp?: number;
}

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  private readonly coalesced: PointerEvent[];

  constructor(type: string, init: TestPointerEventInit = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.coalesced = init.coalesced ?? [];
    if (init.timeStamp !== undefined) {
      Object.defineProperty(this, 'timeStamp', { value: init.timeStamp });
    }
  }

  getCoalescedEvents(): PointerEvent[] {
    return this.coalesced;
  }
}

function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  };
}

type Handle = ReturnType<typeof attachGestures>;

interface HarnessOptions {
  wheel?: GesturePolicy['wheel'];
  navigable?: () => boolean;
  pickRadiusPx?: () => number;
  left?: number;
  top?: number;
  /** Runs inside the emit of each gesture, as a controller's handler would. */
  react?: (gesture: Gesture, handle: Handle) => void;
}

function harness(options: HarnessOptions = {}) {
  const element = document.createElement('canvas');
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  const bounds = rect(800, 600, options.left ?? 0, options.top ?? 0);
  const surface: Surface = {
    element,
    size: () => ({ w: bounds.width, h: bounds.height }),
    rect: () => bounds,
    setNavigable: () => {},
    destroy: () => {},
  };
  const gestures: Gesture[] = [];
  const handle: Handle = attachGestures(
    surface,
    (g) => {
      gestures.push(g);
      options.react?.(g, handle);
    },
    {
      wheel: options.wheel ?? (() => 'zoom'),
      navigable: options.navigable ?? (() => true),
      pickRadiusPx: options.pickRadiusPx ?? (() => 8),
    },
  );
  const kinds = () => gestures.map((g) => g.kind);
  return { element, gestures, handle, kinds };
}

function pointer(type: string, init: TestPointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    coalesced: init.coalesced,
    timeStamp: init.timeStamp,
  } as TestPointerEventInit);
}

function fire(el: HTMLElement, type: string, init: TestPointerEventInit = {}): PointerEvent {
  const event = pointer(type, init);
  el.dispatchEvent(event);
  return event;
}

function fireWheel(el: HTMLElement, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 400,
    clientY: 300,
    deltaMode: 0,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

function fireContextMenu(el: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

const touch = { pointerType: 'touch' } as const;

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('press, drag, and tap', () => {
  it('reports the press with its button, pointer type, modifiers, and pick radius', () => {
    const h = harness({ left: 10, top: 20 });

    fire(h.element, 'pointerdown', { clientX: 110, clientY: 120, shiftKey: true, metaKey: true });

    expect(h.gestures).toEqual([
      {
        kind: 'press',
        sx: 100,
        sy: 100,
        button: 0,
        pointerType: 'mouse',
        shift: true,
        mod: true,
        targetPx: 8,
      },
    ]);
    expect(h.element.setPointerCapture).toHaveBeenCalledWith(1);
    h.handle.destroy();
  });

  it('starts a mouse drag past 3 px with the press point, then incremental moves', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, timeStamp: 5 });
    fire(h.element, 'pointermove', { clientX: 102, clientY: 100, timeStamp: 8 });
    fire(h.element, 'pointermove', { clientX: 104, clientY: 100, timeStamp: 12 });
    fire(h.element, 'pointermove', { clientX: 105, clientY: 102, timeStamp: 16 });

    expect(h.gestures.slice(1)).toEqual([
      { kind: 'dragStart', sx: 100, sy: 100, time: 8 },
      { kind: 'dragMove', sx: 104, sy: 100, dx: 4, dy: 0, time: 12 },
      { kind: 'dragMove', sx: 105, sy: 102, dx: 1, dy: 2, time: 16 },
    ]);
    h.handle.destroy();
  });

  it('uses the 10 px touch threshold and at least a 22 px touch pick radius', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, clientX: 109, clientY: 100 });
    expect(h.kinds()).toEqual(['press']);
    expect(h.gestures[0]).toMatchObject({ pointerType: 'touch', targetPx: 22 });
    fire(h.element, 'pointermove', { ...touch, clientX: 111, clientY: 100 });
    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove']);
    h.handle.destroy();
  });

  it('starts a drag at the coalesced sample that crosses the threshold, folding the rest', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, timeStamp: 10 });
    fire(h.element, 'pointermove', {
      clientX: 106,
      clientY: 100,
      coalesced: [
        pointer('pointermove', { clientX: 102, clientY: 100, timeStamp: 15 }),
        pointer('pointermove', { clientX: 104, clientY: 100, timeStamp: 20 }),
        pointer('pointermove', { clientX: 106, clientY: 100, timeStamp: 30 }),
      ],
    });

    expect(h.gestures.slice(1)).toEqual([
      { kind: 'dragStart', sx: 100, sy: 100, time: 15 },
      { kind: 'dragMove', sx: 106, sy: 100, dx: 6, dy: 0, time: 30 },
    ]);
    h.handle.destroy();
  });

  it('folds the coalesced samples of a drag into one move per event', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, timeStamp: 0 });
    fire(h.element, 'pointermove', { clientX: 110, clientY: 100, timeStamp: 5 });
    fire(h.element, 'pointermove', {
      clientX: 131,
      clientY: 93,
      coalesced: [
        pointer('pointermove', { clientX: 114, clientY: 101, timeStamp: 8 }),
        pointer('pointermove', { clientX: 122, clientY: 97, timeStamp: 12 }),
        pointer('pointermove', { clientX: 131, clientY: 93, timeStamp: 16 }),
      ],
    });
    // Samples that come back to where the event found the pointer move nothing.
    fire(h.element, 'pointermove', {
      clientX: 131,
      clientY: 93,
      coalesced: [
        pointer('pointermove', { clientX: 140, clientY: 90, timeStamp: 20 }),
        pointer('pointermove', { clientX: 131, clientY: 93, timeStamp: 24 }),
      ],
    });
    fire(h.element, 'pointerup', { clientX: 131, clientY: 93 });

    expect(h.gestures.slice(1)).toEqual([
      { kind: 'dragStart', sx: 100, sy: 100, time: 0 },
      { kind: 'dragMove', sx: 110, sy: 100, dx: 10, dy: 0, time: 5 },
      { kind: 'dragMove', sx: 131, sy: 93, dx: 21, dy: -7, time: 16 },
      { kind: 'dragEnd', sx: 131, sy: 93, clientX: 131, clientY: 93, cancelled: false },
      { kind: 'hover', clientX: 131, clientY: 93, targetPx: 8 },
    ]);
    h.handle.destroy();
  });

  it('stops following a drag its dragStart handler cancelled', () => {
    const h = harness({
      react: (g, handle) => {
        if (g.kind === 'dragStart') handle.cancel();
      },
    });

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, timeStamp: 0 });
    fire(h.element, 'pointermove', {
      clientX: 120,
      clientY: 100,
      coalesced: [
        pointer('pointermove', { clientX: 110, clientY: 100, timeStamp: 10 }),
        pointer('pointermove', { clientX: 120, clientY: 100, timeStamp: 20 }),
      ],
    });
    fire(h.element, 'pointerup', { clientX: 120, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragEnd']);
    expect(h.gestures[2]).toMatchObject({ sx: 110, cancelled: true });
    h.handle.destroy();
  });

  it('ends a released drag uncancelled at the release point and refreshes hover', () => {
    const h = harness({ left: 10, top: 20 });

    fire(h.element, 'pointerdown', { clientX: 110, clientY: 120 });
    fire(h.element, 'pointerup', { clientX: 130, clientY: 124 });

    expect(h.gestures.slice(1)).toEqual([
      { kind: 'dragStart', sx: 100, sy: 100, time: expect.any(Number) as number },
      { kind: 'dragMove', sx: 120, sy: 104, dx: 20, dy: 4, time: expect.any(Number) as number },
      { kind: 'dragEnd', sx: 120, sy: 104, clientX: 130, clientY: 124, cancelled: false },
      { kind: 'hover', clientX: 130, clientY: 124, targetPx: 8 },
    ]);
    expect(h.element.releasePointerCapture).toHaveBeenCalledWith(1);
    h.handle.destroy();
  });

  it('does not bracket a pointer drag as navigation: the interactor decides what it moves', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, clientX: 130, clientY: 100 });
    fire(h.element, 'pointerup', { ...touch, clientX: 130, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragEnd']);
    h.handle.destroy();
  });

  it('taps with the press modifiers and double-taps within 400 ms and 25 px', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, shiftKey: true, timeStamp: 0 });
    fire(h.element, 'pointerup', { clientX: 100, clientY: 100, timeStamp: 50 });
    fire(h.element, 'pointerdown', { clientX: 105, clientY: 100, timeStamp: 200 });
    fire(h.element, 'pointerup', { clientX: 105, clientY: 100, timeStamp: 250 });

    // The click that completes a double tap is the double tap alone, never a tap first.
    expect(h.gestures.filter((g) => g.kind !== 'press')).toEqual([
      { kind: 'tap', sx: 100, sy: 100, targetPx: 8, shift: true, mod: false },
      { kind: 'doubleTap', sx: 105, sy: 100, targetPx: 8 },
    ]);
    h.handle.destroy();
  });

  it('starts over after a double tap: a third quick click is a tap', () => {
    const h = harness();

    for (const time of [0, 100, 200]) {
      fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, timeStamp: time });
      fire(h.element, 'pointerup', { clientX: 100, clientY: 100, timeStamp: time + 10 });
    }

    expect(h.kinds()).toEqual(['press', 'tap', 'press', 'doubleTap', 'press', 'tap']);
    h.handle.destroy();
  });

  it('double-taps without navigation too: opening a part is not a camera move', () => {
    const h = harness({ navigable: () => false });

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, timeStamp: 0 });
    fire(h.element, 'pointerup', { clientX: 100, clientY: 100, timeStamp: 10 });
    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100, timeStamp: 100 });
    fire(h.element, 'pointerup', { clientX: 100, clientY: 100, timeStamp: 110 });

    expect(h.kinds()).toEqual(['press', 'tap', 'press', 'doubleTap']);
    h.handle.destroy();
  });

  it('needs matching pointer families, a short gap, and no drag between for a double tap', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 10, clientY: 10, timeStamp: 0 });
    fire(h.element, 'pointerup', { clientX: 10, clientY: 10, timeStamp: 10 });
    fire(h.element, 'pointerdown', { ...touch, clientX: 10, clientY: 10, timeStamp: 20 });
    fire(h.element, 'pointerup', { ...touch, clientX: 10, clientY: 10, timeStamp: 30 });

    fire(h.element, 'pointerdown', { clientX: 20, clientY: 20, timeStamp: 1000 });
    fire(h.element, 'pointerup', { clientX: 20, clientY: 20, timeStamp: 1010 });
    fire(h.element, 'pointerdown', { clientX: 20, clientY: 20, timeStamp: 1500 });
    fire(h.element, 'pointerup', { clientX: 20, clientY: 20, timeStamp: 1510 });

    fire(h.element, 'pointerdown', { clientX: 20, clientY: 20, timeStamp: 2000 });
    fire(h.element, 'pointermove', { clientX: 40, clientY: 20, timeStamp: 2010 });
    fire(h.element, 'pointerup', { clientX: 40, clientY: 20, timeStamp: 2020 });
    fire(h.element, 'pointerdown', { clientX: 20, clientY: 20, timeStamp: 2100 });
    fire(h.element, 'pointerup', { clientX: 20, clientY: 20, timeStamp: 2110 });

    expect(h.kinds().filter((k) => k === 'doubleTap')).toHaveLength(0);
    h.handle.destroy();
  });

  it('turns a middle press into a press and a drag, never a tap', () => {
    const h = harness();

    const down = pointer('pointerdown', { button: 1, clientX: 100, clientY: 100 });
    h.element.dispatchEvent(down);
    fire(h.element, 'pointerup', { button: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { button: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { clientX: 120, clientY: 100 });
    fire(h.element, 'pointerup', { button: 1, clientX: 120, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'press', 'dragStart', 'dragMove', 'dragEnd', 'hover']);
    expect(h.gestures[0]).toMatchObject({ kind: 'press', button: 1 });
    h.handle.destroy();
  });

  it('keeps a middle press from starting autoscroll', () => {
    const h = harness();

    const middle = new MouseEvent('mousedown', { button: 1, cancelable: true });
    const primary = new MouseEvent('mousedown', { button: 0, cancelable: true });
    h.element.dispatchEvent(middle);
    h.element.dispatchEvent(primary);
    expect(middle.defaultPrevented).toBe(true);
    // A primary mousedown keeps its default so the canvas takes focus.
    expect(primary.defaultPrevented).toBe(false);
    h.handle.destroy();
  });
});

describe('cancel', () => {
  it('ends a drag as cancelled at its last point and ignores the pointer until release', () => {
    const h = harness({ left: 10, top: 20 });

    fire(h.element, 'pointerdown', { clientX: 110, clientY: 120 });
    fire(h.element, 'pointermove', { clientX: 150, clientY: 120 });
    h.handle.cancel();
    fire(h.element, 'pointermove', { clientX: 170, clientY: 120 });
    fire(h.element, 'pointerup', { clientX: 170, clientY: 120 });

    expect(h.gestures.slice(3)).toEqual([
      { kind: 'dragEnd', sx: 140, sy: 100, clientX: 150, clientY: 120, cancelled: true },
    ]);
    expect(h.element.releasePointerCapture).toHaveBeenCalledWith(1);

    // Idle again: the next move hovers.
    fire(h.element, 'pointermove', { clientX: 175, clientY: 120 });
    expect(h.kinds().at(-1)).toBe('hover');
    h.handle.destroy();
  });

  it('drops a pending press so its release is not a tap', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    h.handle.cancel();
    fire(h.element, 'pointerup', { clientX: 100, clientY: 100 });
    h.handle.cancel();

    expect(h.kinds()).toEqual(['press']);
    h.handle.destroy();
  });
});

describe('pinch', () => {
  it('starts navigation, then pans and zooms about the midpoint', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, pointerId: 2, clientX: 250, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, pointerId: 1, clientX: 100, clientY: 140 });

    expect(h.gestures.slice(1)).toEqual([
      { kind: 'navigationStart' },
      { kind: 'pan', dx: 25, dy: 0 },
      { kind: 'zoom', factor: 1.5, sx: 175, sy: 100 },
      { kind: 'pan', dx: 0, dy: 20 },
      { kind: 'zoom', factor: Math.hypot(150, 40) / 150, sx: 175, sy: 120 },
    ]);
    h.handle.destroy();
  });

  it('cancels a drag in flight when the second finger lands', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, pointerId: 1, clientX: 120, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 300, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragEnd', 'navigationStart']);
    expect(h.gestures[3]).toMatchObject({ kind: 'dragEnd', sx: 120, cancelled: true });
    h.handle.destroy();
  });

  it('keeps panning with the finger left down and ends navigation when it lifts', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    fire(h.element, 'pointerup', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, pointerId: 2, clientX: 220, clientY: 90 });
    fire(h.element, 'pointerup', { ...touch, pointerId: 2, clientX: 220, clientY: 90 });

    expect(h.gestures.slice(1)).toEqual([
      { kind: 'navigationStart' },
      { kind: 'pan', dx: 20, dy: -10 },
      { kind: 'navigationEnd' },
    ]);
    h.handle.destroy();
  });

  it('ignores pointers outside the pinch', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 3, clientX: 300, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, pointerId: 3, clientX: 350, clientY: 100 });
    fire(h.element, 'pointerup', { ...touch, pointerId: 3, clientX: 350, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'navigationStart']);
    h.handle.destroy();
  });

  it('ignores a second finger without navigation and keeps the first press a tap', () => {
    const h = harness({ navigable: () => false });

    fire(h.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    fire(h.element, 'pointermove', { ...touch, pointerId: 2, clientX: 260, clientY: 100 });
    fire(h.element, 'pointerup', { ...touch, pointerId: 2, clientX: 260, clientY: 100 });
    fire(h.element, 'pointerup', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'tap']);
    expect(h.gestures[1]).toMatchObject({ sx: 100, sy: 100, targetPx: 22 });
    h.handle.destroy();
  });

  it('cancelling a pinch finger ends navigation', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    fire(h.element, 'pointercancel', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'navigationStart', 'navigationEnd', 'hoverEnd']);
    h.handle.destroy();
  });
});

describe('hover and resets', () => {
  it('hovers from idle mouse moves only, and ends hover outside and on leave', () => {
    const h = harness();

    fire(h.element, 'pointermove', { clientX: 50, clientY: 60 });
    fire(h.element, 'pointermove', { ...touch, clientX: 50, clientY: 60 });
    fire(h.element, 'pointermove', { clientX: 900, clientY: 60 });
    fire(h.element, 'pointermove', { pointerType: 'pen', clientX: 70, clientY: 60 });
    fire(h.element, 'pointerleave', { clientX: 70, clientY: 60 });
    fire(h.element, 'pointerleave', { ...touch, clientX: 70, clientY: 60 });

    expect(h.gestures).toEqual([
      { kind: 'hover', clientX: 50, clientY: 60, targetPx: 8 },
      { kind: 'hoverEnd' },
      { kind: 'hover', clientX: 70, clientY: 60, targetPx: 8 },
      { kind: 'hoverEnd' },
    ]);
    h.handle.destroy();
  });

  it('reads the pick radius live', () => {
    let radius = 8;
    const h = harness({ pickRadiusPx: () => radius });

    fire(h.element, 'pointermove', { clientX: 50, clientY: 60 });
    radius = 30;
    fire(h.element, 'pointermove', { clientX: 51, clientY: 60 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 51, clientY: 60 });

    expect(h.gestures.map((g) => ('targetPx' in g ? g.targetPx : null))).toEqual([8, 30, 30]);
    h.handle.destroy();
  });

  it('pauses hover while pressed or dragging', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { clientX: 101, clientY: 100 });
    fire(h.element, 'pointermove', { clientX: 120, clientY: 100 });
    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove']);
    h.handle.destroy();
  });

  it('pointercancel, lost capture, blur, and page hiding end a drag as cancelled', () => {
    const h = harness();
    const drag = () => {
      h.gestures.length = 0;
      fire(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
      fire(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    };

    drag();
    fire(h.element, 'pointercancel', { clientX: 110, clientY: 100 });
    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragEnd', 'hoverEnd']);
    expect(h.gestures[3]).toMatchObject({ kind: 'dragEnd', cancelled: true });

    drag();
    fire(h.element, 'lostpointercapture', { clientX: 110, clientY: 100 });
    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragEnd', 'hoverEnd']);

    drag();
    window.dispatchEvent(new Event('blur'));
    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragEnd', 'hoverEnd']);

    drag();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragEnd', 'hoverEnd']);
    h.handle.destroy();
  });

  it('cancels a pending press without a tap', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, clientX: 100, clientY: 100 });
    fire(h.element, 'pointercancel', { ...touch, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerup', { ...touch, clientX: 100, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'hoverEnd']);
    h.handle.destroy();
  });

  it('cancels on leaving when capture failed, and keeps a captured drag alive', () => {
    const failing = harness();
    vi.mocked(failing.element.setPointerCapture).mockImplementation(() => {
      throw new Error('no capture');
    });
    fire(failing.element, 'pointerdown', { clientX: 100, clientY: 100 });
    fire(failing.element, 'pointermove', { clientX: 110, clientY: 100 });
    fire(failing.element, 'pointerleave', { clientX: 110, clientY: 100 });
    expect(failing.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragEnd', 'hoverEnd']);
    failing.handle.destroy();

    const h = harness();
    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    fire(h.element, 'pointerleave', { clientX: 110, clientY: 100 });
    fire(h.element, 'pointermove', { clientX: 120, clientY: 100 });
    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove', 'dragMove']);
    h.handle.destroy();
  });

  it('destroy removes every listener and emits nothing more', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    h.handle.destroy();
    fire(h.element, 'pointermove', { clientX: 120, clientY: 100 });
    fireWheel(h.element, { deltaY: 100 });
    window.dispatchEvent(new Event('blur'));

    expect(h.kinds()).toEqual(['press', 'dragStart', 'dragMove']);
    expect(h.element.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});

describe('context menu', () => {
  it('forwards a stationary right click whichever of contextmenu or pointerup comes first', () => {
    const before = harness();
    fire(before.element, 'pointerdown', { button: 2, clientX: 100, clientY: 100 });
    fire(before.element, 'pointermove', { clientX: 102, clientY: 100 });
    const early = fireContextMenu(before.element, { button: 2, clientX: 102, clientY: 100 });
    expect(early.defaultPrevented).toBe(true);
    expect(before.gestures).toEqual([]);
    fire(before.element, 'pointerup', { button: 2, clientX: 102, clientY: 100 });
    expect(before.gestures).toEqual([{ kind: 'contextmenu', event: early, keyboard: false }]);
    before.handle.destroy();

    const after = harness();
    fire(after.element, 'pointerdown', { button: 2, clientX: 100, clientY: 100 });
    fire(after.element, 'pointerup', { button: 2, clientX: 100, clientY: 100 });
    const late = fireContextMenu(after.element, { button: 2, clientX: 100, clientY: 100 });
    expect(after.gestures).toEqual([{ kind: 'contextmenu', event: late, keyboard: false }]);
    after.handle.destroy();
  });

  it('never presses or drags with the right button, and a moved right press asks for nothing', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { button: 2, clientX: 100, clientY: 100 });
    fire(h.element, 'pointermove', { clientX: 130, clientY: 100 });
    fire(h.element, 'pointerup', { button: 2, clientX: 130, clientY: 100 });
    const menu = fireContextMenu(h.element, { button: 2, clientX: 130, clientY: 100 });

    expect(menu.defaultPrevented).toBe(true);
    expect(h.gestures).toEqual([]);
    h.handle.destroy();
  });

  it('expires a missing post-pointerup contextmenu without synthesizing one', () => {
    vi.useFakeTimers();
    const h = harness();

    fire(h.element, 'pointerdown', { button: 2, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerup', { button: 2, clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(51);
    expect(h.gestures).toEqual([]);

    const event = fireContextMenu(h.element);
    expect(h.gestures).toEqual([{ kind: 'contextmenu', event, keyboard: true }]);
    h.handle.destroy();
  });

  it('marks a contextmenu with no right press as a keyboard request', () => {
    const h = harness();

    const event = fireContextMenu(h.element, { clientX: 0, clientY: 0 });
    expect(event.defaultPrevented).toBe(true);
    expect(h.gestures).toEqual([{ kind: 'contextmenu', event, keyboard: true }]);
    h.handle.destroy();
  });

  it('suppresses the menu after a cancelled right press', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { button: 2, clientX: 100, clientY: 100 });
    fire(h.element, 'pointercancel', { button: 2, clientX: 100, clientY: 100 });
    fireContextMenu(h.element, { button: 2, clientX: 100, clientY: 100 });

    expect(h.kinds()).toEqual(['hoverEnd']);
    h.handle.destroy();
  });

  it('ignores a right press during a primary gesture', () => {
    const h = harness();

    fire(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { button: 2, pointerId: 2, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerup', { clientX: 100, clientY: 100 });

    expect(h.kinds()).toEqual(['press', 'tap']);
    h.handle.destroy();
  });
});

describe('wheel', () => {
  it('zooms about the cursor and brackets a burst as one navigation', () => {
    vi.useFakeTimers();
    const h = harness({ left: 10, top: 20 });

    const first = fireWheel(h.element, { clientX: 410, clientY: 320, deltaY: 100 });
    vi.advanceTimersByTime(100);
    fireWheel(h.element, { clientX: 410, clientY: 320, deltaY: -100 });
    vi.advanceTimersByTime(119);

    expect(first.defaultPrevented).toBe(true);
    expect(h.gestures).toEqual([
      { kind: 'navigationStart' },
      { kind: 'zoom', factor: Math.exp(-0.1), sx: 400, sy: 300 },
      { kind: 'zoom', factor: Math.exp(0.1), sx: 400, sy: 300 },
    ]);
    vi.advanceTimersByTime(1);
    expect(h.kinds().at(-1)).toBe('navigationEnd');
    h.handle.destroy();
  });

  it('pans by normalized deltas in pixel, line, and page modes', () => {
    const h = harness({ wheel: () => 'pan' });

    fireWheel(h.element, { deltaY: 120, deltaMode: 0 });
    fireWheel(h.element, { deltaY: 3, deltaMode: 1 });
    fireWheel(h.element, { deltaY: 1, deltaMode: 2 });
    fireWheel(h.element, { deltaX: 5, deltaY: -2, deltaMode: 0 });

    expect(h.gestures.filter((g) => g.kind === 'pan')).toEqual([
      { kind: 'pan', dx: -0, dy: -120 },
      { kind: 'pan', dx: -0, dy: -99 },
      { kind: 'pan', dx: -0, dy: -800 },
      { kind: 'pan', dx: -5, dy: 2 },
    ]);
    h.handle.destroy();
  });

  it('leaves a declined wheel, or any wheel without navigation, to the page', () => {
    const declined = harness({ wheel: (e) => (e.ctrlKey ? 'zoom' : 'none') });
    expect(fireWheel(declined.element, { deltaY: 120 }).defaultPrevented).toBe(false);
    expect(declined.gestures).toEqual([]);
    expect(fireWheel(declined.element, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(declined.kinds()).toEqual(['navigationStart', 'zoom']);
    declined.handle.destroy();

    let navigable = false;
    const inspect = harness({ navigable: () => navigable });
    expect(fireWheel(inspect.element, { deltaY: 120 }).defaultPrevented).toBe(false);
    expect(inspect.gestures).toEqual([]);
    navigable = true;
    fireWheel(inspect.element, { deltaY: 120 });
    expect(inspect.kinds()).toEqual(['navigationStart', 'zoom']);
    inspect.handle.destroy();
  });

  it('ignores no-op wheels and wheel pans during a pinch', () => {
    const zoom = harness();
    fireWheel(zoom.element, { deltaX: 10, deltaY: 0 });
    fireWheel(zoom.element, { deltaY: 1_000_000 });
    expect(zoom.gestures).toEqual([]);
    zoom.handle.destroy();

    const pan = harness({ wheel: () => 'pan' });
    fire(pan.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(pan.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    fireWheel(pan.element, { deltaY: 10 });
    expect(pan.kinds()).toEqual(['press', 'navigationStart']);
    pan.handle.destroy();
  });

  it('keeps navigation open until the pinch and the wheel burst both end', () => {
    vi.useFakeTimers();
    const h = harness();

    fire(h.element, 'pointerdown', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerdown', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    fireWheel(h.element, { deltaY: 10 });
    fire(h.element, 'pointerup', { ...touch, pointerId: 1, clientX: 100, clientY: 100 });
    fire(h.element, 'pointerup', { ...touch, pointerId: 2, clientX: 200, clientY: 100 });
    expect(h.kinds().filter((k) => k === 'navigationEnd')).toHaveLength(0);

    vi.advanceTimersByTime(120);
    expect(h.kinds().filter((k) => k === 'navigationStart')).toHaveLength(1);
    expect(h.kinds().filter((k) => k === 'navigationEnd')).toHaveLength(1);
    h.handle.destroy();
  });
});
