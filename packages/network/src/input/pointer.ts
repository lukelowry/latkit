import type { Viewport } from '../camera/projection.js';
import type { Surface } from './surface.js';

/**
 * Normalized pointer gesture emitted by the DOM input adapter.
 *
 * Screen coordinates and deltas are in CSS px relative to the canvas; `vp` is
 * the CSS-pixel canvas viewport captured from the same DOMRect as the event.
 */
export type Intent =
  /** First active camera-navigation source (pointer or wheel) started. */
  | { kind: 'navigationStart' }
  /** Last active camera-navigation source ended; probe is the live hover point. */
  | { kind: 'navigationEnd'; probe: HoverProbe | null }
  /** Primary pointer crossed its drag threshold. */
  | { kind: 'dragStart'; sx: number; sy: number; vp: Viewport; time: number }
  /** Primary pointer moved during a drag; `dx`/`dy` are incremental CSS px. */
  | {
      kind: 'dragMove';
      dx: number;
      dy: number;
      sx: number;
      sy: number;
      vp: Viewport;
      time: number;
    }
  /** End the camera's drag session; only a natural release may coast. */
  | { kind: 'dragEnd'; coast: boolean; time: number }
  /** Wheel gesture interpreted as panning by CSS px. */
  | { kind: 'pan'; dx: number; dy: number; vp: Viewport }
  /** Wheel or pinch zoom at a canvas-local CSS-px anchor. */
  | { kind: 'zoom'; factor: number; sx: number; sy: number; vp: Viewport }
  /** Right-drag or two-finger twist mapped to projection rotation pixels. */
  | { kind: 'rotate'; dxPx: number; dyPx: number; vp: Viewport }
  /** Click/tap hit request with a target radius in CSS px. */
  | { kind: 'tap'; sx: number; sy: number; targetPx: number; vp: Viewport }
  /** Second nearby tap inside the double-tap window. */
  | { kind: 'doubleTap'; sx: number; sy: number; targetPx: number; vp: Viewport }
  /** Hover hit request from a mouse or pen pointer. */
  | ({ kind: 'hover' } & HoverProbe)
  /** Hoverable pointer left the canvas while idle. */
  | { kind: 'hoverEnd' };

/** Physical hover-capable pointer position, independent of canvas layout. */
export interface HoverProbe {
  /** Client-space x; converted with the current DOMRect at pick time. */
  clientX: number;
  /** Client-space y; converted with the current DOMRect at pick time. */
  clientY: number;
  /** Pick target radius in CSS px for this pointer type. */
  targetPx: number;
}

/** Decides whether a wheel event is zoom or pan for this surface. */
export interface WheelPolicy {
  /** Return true when the wheel event should zoom; otherwise it pans. */
  isZoom(e: WheelEvent): boolean;
}

/** Gesture recognition thresholds and double-tap windows. */
const POINTER = {
  /** Mouse drag threshold. 3px is the de-facto convention across Win/GTK/macOS. */
  dragMousePx: 3,

  /** Touch drag threshold. Finger contact wobbles 5-8px on settle. */
  dragTouchPx: 10,

  /** Apple HIG: max gap between taps for double-tap recognition. */
  doubleTapMs: 400,

  /** Apple HIG approximately 28pt finger-reposition slack. */
  doubleTapPx: 25,
} as const;

/** Pick target radii by pointer family, in CSS px. */
const PICK = {
  /** Mouse/pen click target floor; larger than the 2px LOD floor. */
  mousePx: 10,

  /** Touch click target. Half of Apple HIG 44pt diameter, expressed as radius. */
  touchPx: 22,
} as const;

/** Wheel delta normalization and zoom gain. */
const WHEEL = {
  /** Zoom multiplier per pixel of wheel delta; one wheel notch is about 1.1x. */
  sensitivity: 0.001,

  /** DOM_DELTA_LINE to pixels. 33 is the historical Chrome/Firefox baseline. */
  pxPerLine: 33,

  /** Quiet period that closes one browser wheel transaction. */
  endMs: 120,
} as const;

/** Touch rotation gain for two-pointer twist gestures. */
const ROTATE = {
  /** Two-finger twist gain: rotate-drag pixels per degree of finger
   *  rotation, so a physical twist maps ~1:1 onto the projection's
   *  bearing rate. */
  twistPxPerDeg: 2.5,
} as const;

/** Squared mouse drag threshold in CSS px. */
const DRAG_MOUSE_SQ = POINTER.dragMousePx * POINTER.dragMousePx;
/** Squared touch drag threshold in CSS px. */
const DRAG_TOUCH_SQ = POINTER.dragTouchPx * POINTER.dragTouchPx;
/** Squared maximum gap between taps for double-tap recognition. */
const DOUBLE_TAP_SQ = POINTER.doubleTapPx * POINTER.doubleTapPx;

/** Default wheel policy: pinch/modified wheels zoom, pixel trackpads pan. */
export const DEFAULT_WHEEL_POLICY: WheelPolicy = {
  isZoom(e) {
    if (e.ctrlKey || e.metaKey) return true;
    if (e.deltaMode === 0 && (e.deltaX !== 0 || e.deltaY % 1 !== 0)) return false;
    return true;
  },
};

/** Active pointer snapshot in canvas-local CSS pixels. */
interface PointerSlot {
  /** DOM pointer id used for capture and release. */
  id: number;
  /** Canvas-local x in CSS px. */
  sx: number;
  /** Canvas-local y in CSS px. */
  sy: number;
  /** DOM pointer type such as `mouse`, `pen`, or `touch`. */
  type: string;
  /** Pick target radius in CSS px for this pointer type. */
  targetPx: number;
}

/** Stored tap candidate used to recognize a subsequent double-tap. */
interface LastTap {
  /** DOM event timestamp for the tap. */
  time: number;
  /** Canvas-local x in CSS px. */
  sx: number;
  /** Canvas-local y in CSS px. */
  sy: number;
  /** Pointer family must match across a double tap. */
  pointerType: string;
}

/**
 * Pointer state machine.
 *
 * Invariant the camera relies on (see the drag-mirror and velocity-EMA loops
 * in camera.ts): rotation and dragging never coexist. Twist lives in
 * `pinching`, mouse rotate in `rotating`; both are structurally exclusive
 * with `dragging`.
 */
type State =
  | { kind: 'idle'; lastTap: LastTap | null }
  | {
      kind: 'pressed';
      pointer: PointerSlot;
      startSx: number;
      startSy: number;
      /** Timestamp of the preceding down/move sample. */
      lastTime: number;
      thresholdSq: number;
      targetPx: number;
      lastTap: LastTap | null;
    }
  | {
      kind: 'dragging';
      pointer: PointerSlot;
      lastSx: number;
      lastSy: number;
      lastTap: LastTap | null;
    }
  | {
      kind: 'rotating';
      pointer: PointerSlot;
      lastSx: number;
      lastSy: number;
      lastTap: LastTap | null;
    }
  | {
      kind: 'pinching';
      a: PointerSlot;
      b: PointerSlot;
      prevDist: number;
      prevAngle: number;
      lastTap: LastTap | null;
    };

/** Canvas-local event coordinates plus the viewport read from the same rect. */
interface ScreenPoint {
  /** Canvas-local x in CSS px. */
  sx: number;
  /** Canvas-local y in CSS px. */
  sy: number;
  /** CSS-pixel canvas viewport at event time. */
  vp: Viewport;
}

/**
 * Attach DOM pointer, wheel, and lifecycle listeners to a surface.
 *
 * The returned disposer removes listeners, releases captures, and emits no
 * synthetic events after cleanup.
 */
export function attachPointer(
  surface: Surface,
  emit: (i: Intent) => void,
  wheel: WheelPolicy = DEFAULT_WHEEL_POLICY,
): { destroy(): void } {
  const element = surface.element;
  let state: State = { kind: 'idle', lastTap: null };
  let latestProbe: HoverProbe | null = null;
  let pointerNavigating = false;
  let wheelNavigating = false;
  let wheelEndTimer: ReturnType<typeof setTimeout> | null = null;
  const captured = new Set<number>();

  function screen(e: PointerEvent | WheelEvent, rect = surface.rect()): ScreenPoint {
    return {
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
      vp: { w: rect.width, h: rect.height },
    };
  }

  function slot(e: PointerEvent, s: ScreenPoint): PointerSlot {
    return {
      id: e.pointerId,
      sx: s.sx,
      sy: s.sy,
      type: e.pointerType,
      targetPx: targetPxFor(e.pointerType),
    };
  }

  function capture(id: number): boolean {
    try {
      element.setPointerCapture(id);
      captured.add(id);
      return true;
    } catch {
      /* capture can fail after cancel/up */
      return false;
    }
  }

  function release(id: number): void {
    if (!captured.delete(id)) return;
    try {
      element.releasePointerCapture(id);
    } catch {
      /* capture can already be gone */
    }
  }

  /** Clear double-tap eligibility after any non-tap interaction. */
  function clearTapMemory(): void {
    if (state.lastTap) state = { ...state, lastTap: null };
  }

  /** Emit one aggregate navigation lifecycle across pointer/wheel overlap. */
  function beginNavigation(source: 'pointer' | 'wheel'): void {
    const wasNavigating = pointerNavigating || wheelNavigating;
    if (source === 'pointer') pointerNavigating = true;
    else wheelNavigating = true;
    clearTapMemory();
    if (!wasNavigating) emit({ kind: 'navigationStart' });
  }

  function endNavigation(source: 'pointer' | 'wheel', probe = latestProbe): void {
    const wasActive = source === 'pointer' ? pointerNavigating : wheelNavigating;
    if (!wasActive) return;
    if (source === 'pointer') pointerNavigating = false;
    else wheelNavigating = false;
    if (!pointerNavigating && !wheelNavigating) emit({ kind: 'navigationEnd', probe });
  }

  /** Store a hoverable pointer in client coordinates, invalidating it outside. */
  function updateProbe(e: PointerEvent, rect: DOMRect): void {
    if (!isHoverable(e.pointerType)) return;
    latestProbe = containsClientPoint(rect, e.clientX, e.clientY)
      ? { clientX: e.clientX, clientY: e.clientY, targetPx: targetPxFor(e.pointerType) }
      : null;
  }

  /** Cancel the pointer FSM while preserving an overlapping wheel transaction. */
  function cancelPointer(emitIntents: boolean, time = performance.now()): void {
    const hadDrag = state.kind === 'dragging' || state.kind === 'pinching';
    const wasNavigating = pointerNavigating;
    const ids = statePointerIds(state);
    state = { kind: 'idle', lastTap: null };
    latestProbe = null;
    pointerNavigating = false;
    for (const id of ids) release(id);
    if (!emitIntents) return;
    if (hadDrag) emit({ kind: 'dragEnd', coast: false, time });
    if (wasNavigating && !wheelNavigating) emit({ kind: 'navigationEnd', probe: null });
    emit({ kind: 'hoverEnd' });
  }

  /** Cancel every source for blur, page hiding, teardown, and similar resets. */
  function reset(emitIntents: boolean, time = performance.now()): void {
    const hadDrag = state.kind === 'dragging' || state.kind === 'pinching';
    const wasNavigating = pointerNavigating || wheelNavigating;
    const ids = statePointerIds(state);
    state = { kind: 'idle', lastTap: null };
    latestProbe = null;
    pointerNavigating = false;
    wheelNavigating = false;
    if (wheelEndTimer !== null) clearTimeout(wheelEndTimer);
    wheelEndTimer = null;
    for (const id of ids) release(id);
    captured.clear();
    if (!emitIntents) return;
    if (hadDrag) emit({ kind: 'dragEnd', coast: false, time });
    if (wasNavigating) emit({ kind: 'navigationEnd', probe: null });
    emit({ kind: 'hoverEnd' });
  }

  function onPointerDown(e: PointerEvent): void {
    const rect = surface.rect();
    const s = screen(e, rect);
    updateProbe(e, rect);

    // Right-button drag rotates (pitch/bearing on projections with the
    // degree of freedom; a no-op elsewhere). Only from idle; rotation
    // never coexists with dragging or pinching (see the State invariant).
    // The canvas suppresses contextmenu, so right-drag is clean.
    if (e.button === 2) {
      if (state.kind !== 'idle') return;
      const p = slot(e, s);
      capture(p.id);
      state = { kind: 'rotating', pointer: p, lastSx: s.sx, lastSy: s.sy, lastTap: null };
      beginNavigation('pointer');
      return;
    }
    if (e.button !== 0) return;

    if (state.kind === 'idle') {
      const p = slot(e, s);
      state = {
        kind: 'pressed',
        pointer: p,
        startSx: s.sx,
        startSy: s.sy,
        lastTime: e.timeStamp,
        thresholdSq: e.pointerType === 'touch' ? DRAG_TOUCH_SQ : DRAG_MOUSE_SQ,
        targetPx: p.targetPx,
        lastTap: state.lastTap,
      };
      return;
    }

    if (state.kind === 'pressed' || state.kind === 'dragging') {
      const first = state.pointer;
      const second = slot(e, s);
      if (state.kind === 'dragging') {
        emit({ kind: 'dragEnd', coast: false, time: e.timeStamp });
      }
      capture(first.id);
      capture(second.id);
      const next: State = {
        kind: 'pinching',
        a: first,
        b: second,
        prevDist: distance(first, second),
        prevAngle: angleDeg(first, second),
        lastTap: null,
      };
      state = next;
      beginNavigation('pointer');
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const rect = surface.rect();
    updateProbe(e, rect);
    if (state.kind === 'pressed' || state.kind === 'dragging' || state.kind === 'rotating') {
      const events = e.getCoalescedEvents?.();
      const batch = events?.length ? events : [e];
      for (const pe of batch) processPointerMove(pe, rect);
      return;
    }

    processPointerMove(e, rect);
  }

  function processPointerMove(e: PointerEvent, rect: DOMRect): void {
    const s = screen(e, rect);
    switch (state.kind) {
      case 'idle':
        if (isHoverable(e.pointerType)) {
          if (latestProbe) emit({ kind: 'hover', ...latestProbe });
          else emit({ kind: 'hoverEnd' });
        }
        return;

      case 'pressed': {
        if (e.pointerId !== state.pointer.id) return;
        const dx = s.sx - state.startSx;
        const dy = s.sy - state.startSy;
        const p = { ...state.pointer, sx: s.sx, sy: s.sy };
        if (dx * dx + dy * dy <= state.thresholdSq) {
          state = { ...state, pointer: p, lastTime: e.timeStamp };
          return;
        }

        capture(p.id);
        beginNavigation('pointer');
        emit({
          kind: 'dragStart',
          sx: state.startSx,
          sy: state.startSy,
          vp: s.vp,
          time: state.lastTime,
        });
        emit({ kind: 'dragMove', dx, dy, sx: s.sx, sy: s.sy, vp: s.vp, time: e.timeStamp });
        state = {
          kind: 'dragging',
          pointer: p,
          lastSx: s.sx,
          lastSy: s.sy,
          lastTap: null,
        };
        return;
      }

      case 'dragging': {
        if (e.pointerId !== state.pointer.id) return;
        const dx = s.sx - state.lastSx;
        const dy = s.sy - state.lastSy;
        state = {
          ...state,
          pointer: { ...state.pointer, sx: s.sx, sy: s.sy },
          lastSx: s.sx,
          lastSy: s.sy,
        };
        if (dx !== 0 || dy !== 0) {
          emit({ kind: 'dragMove', dx, dy, sx: s.sx, sy: s.sy, vp: s.vp, time: e.timeStamp });
        }
        return;
      }

      case 'rotating': {
        if (e.pointerId !== state.pointer.id) return;
        const dx = s.sx - state.lastSx;
        const dy = s.sy - state.lastSy;
        state = {
          ...state,
          pointer: { ...state.pointer, sx: s.sx, sy: s.sy },
          lastSx: s.sx,
          lastSy: s.sy,
        };
        if (dx !== 0 || dy !== 0) emit({ kind: 'rotate', dxPx: dx, dyPx: dy, vp: s.vp });
        return;
      }

      case 'pinching': {
        let a = state.a;
        let b = state.b;
        if (e.pointerId === a.id) a = { ...a, sx: s.sx, sy: s.sy };
        else if (e.pointerId === b.id) b = { ...b, sx: s.sx, sy: s.sy };
        else return;

        const nextDist = distance(a, b);
        const nextAngle = angleDeg(a, b);
        if (state.prevDist > 0) {
          const mid = midpoint(a, b);
          const factor = nextDist / state.prevDist;
          if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
            emit({ kind: 'zoom', factor, sx: mid.sx, sy: mid.sy, vp: s.vp });
          }
          const twist = angleDeltaDeg(state.prevAngle, nextAngle);
          if (twist !== 0) {
            emit({ kind: 'rotate', dxPx: twist * ROTATE.twistPxPerDeg, dyPx: 0, vp: s.vp });
          }
        }
        state = {
          kind: 'pinching',
          a,
          b,
          prevDist: nextDist,
          prevAngle: nextAngle,
          lastTap: null,
        };
        return;
      }

      default:
        /* v8 ignore next -- compile-time exhaustive pointer state guard. */
        assertNever(state);
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const rect = surface.rect();
    updateProbe(e, rect);
    if (state.kind !== 'idle') processPointerMove(e, rect);
    const s = screen(e, rect);

    if (state.kind === 'pressed') {
      if (e.pointerId !== state.pointer.id) return;
      const targetPx = state.targetPx;
      const tap = nextTapMemory(state.lastTap, s, e.timeStamp, e.pointerType);
      state = { kind: 'idle', lastTap: tap.next };
      release(e.pointerId);
      emit({ kind: 'tap', sx: s.sx, sy: s.sy, targetPx, vp: s.vp });
      if (tap.doubleTap) emit({ kind: 'doubleTap', sx: s.sx, sy: s.sy, targetPx, vp: s.vp });
      return;
    }

    if (state.kind === 'dragging') {
      if (e.pointerId !== state.pointer.id) return;
      state = { kind: 'idle', lastTap: null };
      emit({ kind: 'dragEnd', coast: true, time: e.timeStamp });
      endNavigation('pointer');
      release(e.pointerId);
      return;
    }

    if (state.kind === 'rotating') {
      if (e.pointerId !== state.pointer.id) return;
      state = { kind: 'idle', lastTap: null };
      endNavigation('pointer');
      release(e.pointerId);
      return;
    }

    if (state.kind === 'pinching') {
      const remaining: PointerSlot | null =
        e.pointerId === state.a.id ? state.b : e.pointerId === state.b.id ? state.a : null;
      if (!remaining) return;

      state = {
        kind: 'dragging',
        pointer: remaining,
        lastSx: remaining.sx,
        lastSy: remaining.sy,
        lastTap: null,
      };
      release(e.pointerId);
      emit({
        kind: 'dragStart',
        sx: remaining.sx,
        sy: remaining.sy,
        vp: s.vp,
        time: e.timeStamp,
      });
    }
  }

  function onPointerCancel(e: PointerEvent): void {
    if (state.kind === 'pressed') {
      if (e.pointerId !== state.pointer.id) return;
      state = { kind: 'idle', lastTap: null };
      latestProbe = null;
      release(e.pointerId);
      emit({ kind: 'hoverEnd' });
      return;
    }

    if (state.kind === 'dragging') {
      if (e.pointerId !== state.pointer.id) return;
      cancelPointer(true, e.timeStamp);
      return;
    }

    if (state.kind === 'rotating') {
      if (e.pointerId !== state.pointer.id) return;
      cancelPointer(true, e.timeStamp);
      return;
    }

    if (state.kind === 'pinching' && (e.pointerId === state.a.id || e.pointerId === state.b.id)) {
      cancelPointer(true, e.timeStamp);
    }
  }

  function onPointerLeave(e: PointerEvent): void {
    if (isHoverable(e.pointerType)) latestProbe = null;
    if (state.kind === 'idle') {
      if (isHoverable(e.pointerType)) emit({ kind: 'hoverEnd' });
      return;
    }

    if (state.kind === 'pressed' && e.pointerId === state.pointer.id) {
      state = { kind: 'idle', lastTap: null };
      emit({ kind: 'hoverEnd' });
      return;
    }

    // Capture keeps a gesture alive outside the element. If capture failed or
    // was lost, leaving must cancel the FSM instead of leaving it stuck.
    if (!captured.has(e.pointerId) && ownsPointer(state, e.pointerId)) {
      cancelPointer(true, e.timeStamp);
    }
  }

  function onLostPointerCapture(e: PointerEvent): void {
    captured.delete(e.pointerId);
    if (ownsPointer(state, e.pointerId)) cancelPointer(true, e.timeStamp);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const px = pixelsForDelta(e.deltaX, e.deltaMode);
    const py = pixelsForDelta(e.deltaY, e.deltaMode);
    if (!Number.isFinite(px) || !Number.isFinite(py) || (px === 0 && py === 0)) return;

    const rect = surface.rect();
    const s = screen(e, rect);
    latestProbe = containsClientPoint(rect, e.clientX, e.clientY)
      ? { clientX: e.clientX, clientY: e.clientY, targetPx: PICK.mousePx }
      : null;

    const zooming = wheel.isZoom(e);
    const factor = zooming ? Math.exp(-py * WHEEL.sensitivity) : 1;
    // Invalid, underflowed, and unit zooms must not begin or extend a wheel
    // transaction because they cannot change the camera.
    if (zooming && (!Number.isFinite(factor) || factor <= 0 || factor === 1)) return;
    // A one-shot wheel pan owns Camera's drag session; do not let it replace
    // an active pointer drag/pinch/rotation session.
    if (!zooming && pointerNavigating) return;

    beginNavigation('wheel');
    if (wheelEndTimer !== null) clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      wheelEndTimer = null;
      endNavigation('wheel');
    }, WHEEL.endMs);

    if (zooming) {
      emit({
        kind: 'zoom',
        factor,
        sx: s.sx,
        sy: s.sy,
        vp: s.vp,
      });
    } else {
      emit({ kind: 'pan', dx: -px, dy: -py, vp: s.vp });
    }
  }

  function onBlur(): void {
    reset(true);
  }

  function onVisibilityChange(): void {
    if (document.hidden) reset(true);
  }

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);
  element.addEventListener('pointerleave', onPointerLeave);
  element.addEventListener('lostpointercapture', onLostPointerCapture);
  element.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    /** Detach listeners, release captures, and reset gesture state. */
    destroy() {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerCancel);
      element.removeEventListener('pointerleave', onPointerLeave);
      element.removeEventListener('lostpointercapture', onLostPointerCapture);
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reset(false);
    },
  };
}

/** Target radius for tap/hover picking by pointer type, in CSS px. */
function targetPxFor(pointerType: string): number {
  return pointerType === 'touch' ? PICK.touchPx : PICK.mousePx;
}

/** Whether a pointer type can emit hover intents while idle. */
function isHoverable(pointerType: string): boolean {
  return pointerType === 'mouse' || pointerType === 'pen';
}

/** Euclidean distance between two active pointers in CSS px. */
function distance(a: PointerSlot, b: PointerSlot): number {
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Angle from pointer `a` to `b` in screen-space degrees. */
function angleDeg(a: PointerSlot, b: PointerSlot): number {
  return Math.atan2(b.sy - a.sy, b.sx - a.sx) * (180 / Math.PI);
}

/** Shortest signed angle delta in degrees, respecting wrap. */
function angleDeltaDeg(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Midpoint between two active pointers in canvas-local CSS px. */
function midpoint(a: PointerSlot, b: PointerSlot): { sx: number; sy: number } {
  return { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 };
}

/** Convert DOM wheel delta units to CSS px. */
function pixelsForDelta(d: number, mode: number): number {
  if (mode === 0) return d;
  if (mode === 1) return d * WHEEL.pxPerLine;
  return d * window.innerHeight;
}

/** Whether a client-space point is inside the current canvas border box. */
function containsClientPoint(rect: DOMRect, clientX: number, clientY: number): boolean {
  return (
    Number.isFinite(clientX) &&
    Number.isFinite(clientY) &&
    clientX >= rect.left &&
    clientY >= rect.top &&
    clientX < rect.right &&
    clientY < rect.bottom
  );
}

/** Whether one active FSM state owns a pointer id. */
function ownsPointer(state: State, pointerId: number): boolean {
  if (state.kind === 'pressed' || state.kind === 'dragging' || state.kind === 'rotating') {
    return state.pointer.id === pointerId;
  }
  return state.kind === 'pinching' && (state.a.id === pointerId || state.b.id === pointerId);
}

/** Snapshot owned pointer ids before transitioning the FSM to idle. */
function statePointerIds(state: State): number[] {
  if (state.kind === 'pressed' || state.kind === 'dragging' || state.kind === 'rotating') {
    return [state.pointer.id];
  }
  return state.kind === 'pinching' ? [state.a.id, state.b.id] : [];
}

/** Update tap memory and report whether the current tap is a double-tap. */
function nextTapMemory(
  lastTap: LastTap | null,
  s: ScreenPoint,
  time: number,
  pointerType: string,
): { next: LastTap | null; doubleTap: boolean } {
  const dx = lastTap ? s.sx - lastTap.sx : Infinity;
  const dy = lastTap ? s.sy - lastTap.sy : Infinity;
  const doubleTap =
    !!lastTap &&
    pointerType === lastTap.pointerType &&
    time >= lastTap.time &&
    time - lastTap.time < POINTER.doubleTapMs &&
    dx * dx + dy * dy < DOUBLE_TAP_SQ;
  return {
    next: doubleTap ? null : { time, sx: s.sx, sy: s.sy, pointerType },
    doubleTap,
  };
}

/** Exhaustiveness guard for pointer state switches. */
/* v8 ignore next 3 -- called only if the typed State union stops being exhaustive. */
function assertNever(x: never): never {
  throw new Error(`unreachable pointer state: ${JSON.stringify(x)}`);
}
