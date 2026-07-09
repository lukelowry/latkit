// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachPointer,
  DEFAULT_WHEEL_POLICY,
  type Intent,
  type WheelPolicy,
} from '../src/input/pointer.js';
import type { Surface } from '../src/input/surface.js';

interface TestPointerEventInit extends PointerEventInit {
  coalesced?: PointerEvent[];
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

function harness(policy?: WheelPolicy) {
  const element = document.createElement('canvas');
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  const bounds = rect(800, 600);
  const surface: Surface = {
    element,
    size: () => ({ w: bounds.width, h: bounds.height }),
    rect: () => bounds,
    destroy: () => {},
  };
  const intents: Intent[] = [];
  const handle = attachPointer(surface, (i) => intents.push(i), policy);
  return { element, intents, handle };
}

function pointer(type: string, init: TestPointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    coalesced: init.coalesced,
  } as TestPointerEventInit);
}

function firePointer(el: HTMLElement, type: string, init: TestPointerEventInit = {}): PointerEvent {
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

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

describe('attachPointer drag and tap recognition', () => {
  it('mouse drag starts after the 3px threshold and carries press and live positions', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 102, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 104, clientY: 100 });

    expect(h.intents).toEqual([
      { kind: 'dragStart', sx: 100, sy: 100, vp: { w: 800, h: 600 } },
      { kind: 'dragMove', dx: 4, dy: 0, sx: 104, sy: 100, vp: { w: 800, h: 600 } },
    ]);
    h.handle.destroy();
  });

  it('touch drag uses the 10px threshold', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { pointerType: 'touch', clientX: 109, clientY: 100 });
    expect(h.intents).toHaveLength(0);
    firePointer(h.element, 'pointermove', { pointerType: 'touch', clientX: 111, clientY: 100 });
    expect(h.intents.map((i) => i.kind)).toEqual(['dragStart', 'dragMove']);
    h.handle.destroy();
  });

  it('processes coalesced drag events with one rect read per pointermove', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', {
      clientX: 106,
      clientY: 100,
      coalesced: [
        pointer('pointermove', { clientX: 102, clientY: 100 }),
        pointer('pointermove', { clientX: 106, clientY: 100 }),
      ],
    });

    expect(h.intents.map((i) => i.kind)).toEqual(['dragStart', 'dragMove']);
    expect(h.intents[1]).toMatchObject({ dx: 6, sx: 106 });
    h.handle.destroy();
  });

  it('tap and doubleTap both fire, in order, with mouse target radius', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointerup', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointerdown', { clientX: 105, clientY: 100 });
    firePointer(h.element, 'pointerup', { clientX: 105, clientY: 100 });

    expect(h.intents.map((i) => i.kind)).toEqual(['tap', 'tap', 'doubleTap']);
    expect(h.intents[0]).toMatchObject({ sx: 100, sy: 100, targetPx: 10 });
    expect(h.intents[2]).toMatchObject({ sx: 105, sy: 100, targetPx: 10 });
    h.handle.destroy();
  });

  it('touch taps carry the touch target radius', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 20 });
    firePointer(h.element, 'pointerup', { pointerType: 'touch', clientX: 10, clientY: 20 });

    expect(h.intents).toEqual([
      { kind: 'tap', sx: 10, sy: 20, targetPx: 22, vp: { w: 800, h: 600 } },
    ]);
    h.handle.destroy();
  });
});

describe('attachPointer pinch lifecycle', () => {
  it('entering pinch emits a seed zoom before pinch moves', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 200,
      clientY: 100,
    });
    firePointer(h.element, 'pointermove', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 250,
      clientY: 100,
    });

    expect(h.intents[0]).toMatchObject({ kind: 'zoom', factor: 1, sx: 150, sy: 100 });
    expect(h.intents[1]).toMatchObject({ kind: 'zoom', factor: 1.5, sx: 175, sy: 100 });
    h.handle.destroy();
  });

  it('second finger during drag ends drag before seed zoom', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 100,
    });
    firePointer(h.element, 'pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 300,
      clientY: 100,
    });

    expect(h.intents.map((i) => i.kind)).toEqual(['dragStart', 'dragMove', 'dragEnd', 'zoom']);
    expect(h.intents[3]).toMatchObject({ kind: 'zoom', factor: 1, sx: 210, sy: 100 });
    h.handle.destroy();
  });

  it('lifting either pinch slot promotes the remaining pointer to dragging', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 200,
      clientY: 100,
    });
    firePointer(h.element, 'pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointermove', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 220,
      clientY: 100,
    });

    expect(h.intents.map((i) => i.kind)).toEqual(['zoom', 'dragStart', 'dragMove']);
    expect(h.intents[1]).toMatchObject({ kind: 'dragStart', sx: 200, sy: 100 });
    expect(h.intents[2]).toMatchObject({ kind: 'dragMove', dx: 20, dy: 0, sx: 220, sy: 100 });
    h.handle.destroy();
  });

  it('ignores move and up events for pointers outside the active pinch slots', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 200,
      clientY: 100,
    });
    firePointer(h.element, 'pointermove', {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 300,
      clientY: 100,
    });
    firePointer(h.element, 'pointerup', {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 300,
      clientY: 100,
    });

    expect(h.intents.map((i) => i.kind)).toEqual(['zoom']);
    h.handle.destroy();
  });
});

describe('attachPointer hover and cancellation', () => {
  it('gates hover during drag and emits synthetic hover on natural mouse drag end', () => {
    const h = harness();

    firePointer(h.element, 'pointermove', { clientX: 50, clientY: 50 });
    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 120, clientY: 100 });
    firePointer(h.element, 'pointerup', { clientX: 120, clientY: 100 });

    expect(h.intents.map((i) => i.kind)).toEqual([
      'hover',
      'dragStart',
      'dragMove',
      'dragMove',
      'dragEnd',
      'hover',
    ]);
    expect(h.intents[5]).toMatchObject({ kind: 'hover', sx: 120, sy: 100, targetPx: 10 });
    h.handle.destroy();
  });

  it('does not emit synthetic hover after touch drag', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { pointerType: 'touch', clientX: 120, clientY: 100 });
    firePointer(h.element, 'pointerup', { pointerType: 'touch', clientX: 120, clientY: 100 });

    expect(h.intents.map((i) => i.kind)).toEqual(['dragStart', 'dragMove', 'dragEnd']);
    h.handle.destroy();
  });

  it('pointerleave from pressed resets silently; pointerleave from captured drag is a no-op', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointerleave', { clientX: 101, clientY: 100 });
    firePointer(h.element, 'pointerup', { clientX: 101, clientY: 100 });
    expect(h.intents).toHaveLength(0);

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    firePointer(h.element, 'pointerleave', { clientX: 110, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 120, clientY: 100 });
    expect(h.intents.map((i) => i.kind)).toEqual(['dragStart', 'dragMove', 'dragMove']);
    h.handle.destroy();
  });

  it('emits hoverEnd when a hoverable idle pointer leaves the surface', () => {
    const h = harness();

    firePointer(h.element, 'pointermove', { clientX: 50, clientY: 50 });
    firePointer(h.element, 'pointerleave', { clientX: 50, clientY: 50 });
    firePointer(h.element, 'pointerleave', {
      pointerType: 'touch',
      clientX: 50,
      clientY: 50,
    });

    expect(h.intents.map((i) => i.kind)).toEqual(['hover', 'hoverEnd']);
    h.handle.destroy();
  });

  it('cancel, blur, and visibility reset emit dragEnd without synthetic hover', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    firePointer(h.element, 'pointercancel', { clientX: 110, clientY: 100 });
    expect(h.intents.map((i) => i.kind)).toEqual(['dragStart', 'dragMove', 'dragEnd']);

    h.intents.length = 0;
    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    window.dispatchEvent(new Event('blur'));
    expect(h.intents.map((i) => i.kind)).toEqual(['dragStart', 'dragMove', 'dragEnd']);

    h.intents.length = 0;
    firePointer(h.element, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 200,
      clientY: 100,
    });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.intents.map((i) => i.kind)).toEqual(['zoom', 'dragEnd']);
    h.handle.destroy();
  });

  it('cancels pressed, rotating, and pinching gestures without stray intents', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointercancel', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointerup', { clientX: 100, clientY: 100 });
    expect(h.intents).toHaveLength(0);

    firePointer(h.element, 'pointerdown', { button: 2, pointerId: 1, clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { pointerId: 1, clientX: 110, clientY: 100 });
    firePointer(h.element, 'pointercancel', { pointerId: 1, clientX: 110, clientY: 100 });
    expect(h.intents.map((i) => i.kind)).toEqual(['rotate']);

    h.intents.length = 0;
    firePointer(h.element, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 200,
      clientY: 100,
    });
    firePointer(h.element, 'pointercancel', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    expect(h.intents.map((i) => i.kind)).toEqual(['zoom', 'dragEnd']);
    h.handle.destroy();
  });

  it('tolerates capture and release failures from the browser', () => {
    const h = harness();
    vi.mocked(h.element.setPointerCapture).mockImplementation(() => {
      throw new Error('lost capture');
    });
    vi.mocked(h.element.releasePointerCapture).mockImplementation(() => {
      throw new Error('lost capture');
    });

    firePointer(h.element, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 110, clientY: 100 });
    firePointer(h.element, 'pointerup', { clientX: 110, clientY: 100 });

    expect(h.intents.map((i) => i.kind)).toEqual([
      'dragStart',
      'dragMove',
      'dragEnd',
      'hover',
    ]);
    h.handle.destroy();
  });
});

describe('wheel policy and delta conversion', () => {
  it('default wheel policy matches the zoom-vs-pan matrix', () => {
    const cases: Array<[string, WheelEventInit, Intent['kind']]> = [
      ['ctrlKey', { deltaY: 20, ctrlKey: true }, 'zoom'],
      ['metaKey', { deltaY: 20, metaKey: true }, 'zoom'],
      ['integer pixel wheel', { deltaY: 120, deltaMode: 0 }, 'zoom'],
      ['fractional trackpad', { deltaY: 0.5, deltaMode: 0 }, 'pan'],
      ['horizontal trackpad', { deltaX: 2, deltaY: 0, deltaMode: 0 }, 'pan'],
      ['line-mode mouse', { deltaY: 3, deltaMode: 1 }, 'zoom'],
    ];

    for (const [, init, kind] of cases) {
      const h = harness(DEFAULT_WHEEL_POLICY);
      const event = fireWheel(h.element, init);
      expect(event.defaultPrevented).toBe(true);
      expect(h.intents[0]?.kind).toBe(kind);
      h.handle.destroy();
    }
  });

  it('normalizes wheel pan deltas across pixel, line, and page modes', () => {
    const h = harness({ isZoom: () => false });

    fireWheel(h.element, { deltaY: 120, deltaMode: 0 });
    fireWheel(h.element, { deltaY: 3, deltaMode: 1 });
    fireWheel(h.element, { deltaY: 1, deltaMode: 2 });
    fireWheel(h.element, { deltaX: 5, deltaY: -2, deltaMode: 0 });

    expect(h.intents).toEqual([
      { kind: 'pan', dx: -0, dy: -120, vp: { w: 800, h: 600 } },
      { kind: 'pan', dx: -0, dy: -99, vp: { w: 800, h: 600 } },
      { kind: 'pan', dx: -0, dy: -800, vp: { w: 800, h: 600 } },
      { kind: 'pan', dx: -5, dy: 2, vp: { w: 800, h: 600 } },
    ]);
    h.handle.destroy();
  });

  it('normalizes wheel zoom direction', () => {
    const h = harness({ isZoom: () => true });

    fireWheel(h.element, { deltaY: 120 });
    fireWheel(h.element, { deltaY: -120 });

    expect(h.intents[0]).toMatchObject({ kind: 'zoom' });
    expect(h.intents[0].kind === 'zoom' ? h.intents[0].factor : 0).toBeLessThan(1);
    expect(h.intents[1].kind === 'zoom' ? h.intents[1].factor : 0).toBeGreaterThan(1);
    h.handle.destroy();
  });
});

describe('attachPointer rotation', () => {
  it('right-button drag emits rotate deltas, never dragStart', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { button: 2, clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointermove', { clientX: 110, clientY: 95 });
    firePointer(h.element, 'pointerup', { button: 2, clientX: 110, clientY: 95 });

    expect(h.intents).toEqual([{ kind: 'rotate', dxPx: 10, dyPx: -5, vp: { w: 800, h: 600 } }]);
    h.handle.destroy();
  });

  it('a left press during rotation is ignored — rotation never becomes a drag', () => {
    const h = harness();

    firePointer(h.element, 'pointerdown', { button: 2, pointerId: 1, clientX: 100, clientY: 100 });
    firePointer(h.element, 'pointerdown', { button: 0, pointerId: 2, clientX: 200, clientY: 200 });
    firePointer(h.element, 'pointermove', { pointerId: 1, clientX: 105, clientY: 100 });

    expect(h.intents.map((i) => i.kind)).toEqual(['rotate']);
    h.handle.destroy();
  });

  it('two-finger twist emits rotate alongside pinch zoom', () => {
    const h = harness();

    // Two touch points: (100,100) and (200,100) — horizontal baseline.
    firePointer(h.element, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    firePointer(h.element, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 2,
      clientX: 200,
      clientY: 100,
    });
    // Rotate the second finger 45° about the first (same distance).
    const d = 100 / Math.SQRT2;
    firePointer(h.element, 'pointermove', {
      pointerType: 'touch',
      pointerId: 2,
      clientX: 100 + d,
      clientY: 100 + d,
    });

    const rotate = h.intents.find((i) => i.kind === 'rotate');
    expect(rotate).toBeDefined();
    expect(rotate!.kind === 'rotate' ? rotate!.dxPx : 0).toBeCloseTo(45 * 2.5, 3);
    h.handle.destroy();
  });
});
