/**
 * DOM pointer, wheel, and touch input turned into gestures, with no diagram knowledge: the
 * interactor gives them meaning. `sx`/`sy` are canvas-local CSS px.
 */

import type { Surface } from './surface.js';

/** One recognized gesture. */
export type Gesture =
  /**
   * A primary or middle button went down; `targetPx` is the pick radius for its pointer type. It
   * is followed by `tap`, `doubleTap`, `dragStart`, or nothing: a middle click, a pinch taking
   * over, or a cancel. A new `press`, or a second touch starting a pinch, supersedes one still
   * pending; a wheel does not.
   */
  | {
      kind: 'press';
      sx: number;
      sy: number;
      button: number;
      pointerType: string;
      shift: boolean;
      mod: boolean;
      targetPx: number;
    }
  /**
   * The pressed pointer crossed its drag threshold; it only ever follows its own `press`. `sx`/`sy`
   * are where it was pressed, and `time` the last sample still inside the threshold (the press's
   * own, when there was none).
   */
  | { kind: 'dragStart'; sx: number; sy: number; time: number }
  /**
   * The dragging pointer moved: one per pointer event, however many samples the browser coalesced
   * into it. `sx`/`sy` and `time` are the last sample's; `dx`/`dy` are CSS px since the previous
   * `dragMove`, or since the press for the first.
   */
  | { kind: 'dragMove'; sx: number; sy: number; dx: number; dy: number; time: number }
  /** The drag ended: released, or cancelled by a second touch, a lost capture, or Escape. */
  | {
      kind: 'dragEnd';
      sx: number;
      sy: number;
      clientX: number;
      clientY: number;
      cancelled: boolean;
    }
  /**
   * A primary press released without crossing the drag threshold, unless it completes a double
   * tap: that release is a `doubleTap` alone.
   */
  | { kind: 'tap'; sx: number; sy: number; targetPx: number; shift: boolean; mod: boolean }
  /**
   * A second tap near the first inside the double-tap window, in place of its `tap`, so the click
   * that opens a part never first selects, or steps the selection to, what lies beneath it. Its
   * modifiers are its `press`'s.
   */
  | { kind: 'doubleTap'; sx: number; sy: number; targetPx: number }
  /** A mouse or pen moved while idle, or came to rest after a drag. */
  | { kind: 'hover'; clientX: number; clientY: number; targetPx: number }
  /** The hovering pointer left the canvas, or input was reset. */
  | { kind: 'hoverEnd' }
  /** Zoom by `factor` about a canvas-local point: a wheel or a pinch. */
  | { kind: 'zoom'; factor: number; sx: number; sy: number }
  /** Drag the content by CSS px: a wheel, a two-finger pan, or the finger left after a pinch. */
  | { kind: 'pan'; dx: number; dy: number }
  /** A context request, released after right-button disambiguation. */
  | { kind: 'contextmenu'; event: MouseEvent; keyboard: boolean }
  /** The first camera navigation source (a wheel transaction or a pinch) started. */
  | { kind: 'navigationStart' }
  /** The last camera navigation source ended. */
  | { kind: 'navigationEnd' };

/** What the gestures follow, read per event so live options apply at once. */
export interface GesturePolicy {
  /** What a wheel event does: zoom, pan, or nothing, leaving it to the page. */
  readonly wheel: (event: WheelEvent) => 'zoom' | 'pan' | 'none';
  /** Mouse and pen pick radius in CSS px; touch uses at least 22. */
  readonly pickRadiusPx: () => number;
  /** Whether the wheel and a second touch move the camera ('edit' and 'navigate'). */
  readonly navigable: () => boolean;
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

/** Touch pick target floor, in CSS px: half of the Apple HIG 44pt diameter, as a radius. */
const TOUCH_PICK_RADIUS_PX = 22;

/** Wheel delta normalization and zoom gain. */
const WHEEL = {
  /** Zoom multiplier per pixel of wheel delta; one wheel notch is about 1.1x. */
  sensitivity: 0.001,
  /** DOM_DELTA_LINE to pixels. 33 is the historical Chrome/Firefox baseline. */
  pxPerLine: 33,
  /** Quiet period that closes one browser wheel transaction. */
  endMs: 120,
} as const;

/** Grace period for contextmenu events dispatched in a task after pointerup. */
const CONTEXT_RELEASE_MS = 50;

/** Squared mouse drag threshold in CSS px. */
const DRAG_MOUSE_SQ = POINTER.dragMousePx * POINTER.dragMousePx;
/** Squared touch drag threshold in CSS px. */
const DRAG_TOUCH_SQ = POINTER.dragTouchPx * POINTER.dragTouchPx;
/** Squared maximum gap between taps for double-tap recognition. */
const DOUBLE_TAP_SQ = POINTER.doubleTapPx * POINTER.doubleTapPx;

/** Active pointer snapshot. */
interface PointerSlot {
  /** DOM pointer id used for capture and release. */
  readonly id: number;
  /** Canvas-local position in CSS px. */
  sx: number;
  sy: number;
  /** Client position, for a cancelled drag's release point. */
  clientX: number;
  clientY: number;
  /** DOM pointer type such as `mouse`, `pen`, or `touch`. */
  readonly type: string;
  /** Pick target radius in CSS px for this pointer type. */
  readonly targetPx: number;
}

/** Stored tap candidate used to recognize a subsequent double tap. */
interface LastTap {
  readonly time: number;
  readonly sx: number;
  readonly sy: number;
  /** Pointer family must match across a double tap. */
  readonly pointerType: string;
}

/**
 * Pointer state machine. `held` swallows a pointer whose gesture `cancel` ended until it is
 * released; `panning` is the finger left down after a pinch, still navigating.
 */
type State =
  | { kind: 'idle'; lastTap: LastTap | null }
  | {
      kind: 'contextPressed';
      pointer: PointerSlot;
      startSx: number;
      startSy: number;
      contextEvent: MouseEvent | null;
    }
  | {
      kind: 'pressed';
      pointer: PointerSlot;
      button: number;
      shift: boolean;
      mod: boolean;
      startSx: number;
      startSy: number;
      /** Timestamp of the preceding down/move sample. */
      lastTime: number;
      thresholdSq: number;
      lastTap: LastTap | null;
    }
  | { kind: 'dragging'; pointer: PointerSlot }
  | { kind: 'held'; pointer: PointerSlot }
  | {
      kind: 'pinching';
      a: PointerSlot;
      b: PointerSlot;
      prevDist: number;
      prevMidX: number;
      prevMidY: number;
    }
  | { kind: 'panning'; pointer: PointerSlot };

/**
 * Listen to a surface's canvas and emit gestures.
 *
 * @remarks
 * Primary and middle presses emit `press` and capture the pointer; they become a `tap` (primary
 * only; a `doubleTap` instead for the second of two quick taps in one place) or a drag past 3 CSS
 * px (10 for touch). A drag reports one `dragMove` per pointer event, its coalesced samples
 * folded: a frame shows only where the pointer came to, and every move a listener makes is work
 * for the scene. A right press only asks for a context menu, and only when released without
 * moving, whichever order the browser sends `contextmenu` and `pointerup` in. A second touch
 * pinches: `navigationStart`, then `pan` and `zoom` about the midpoint, cancelling a drag in
 * flight. A wheel follows `policy.wheel`, bracketed by one `navigationStart`/`navigationEnd` per
 * burst. Window blur and page hiding reset everything.
 *
 * @returns `cancel` ends an in-flight drag with `dragEnd` `cancelled: true`; `destroy` removes
 * every listener, releases captures, and emits nothing more.
 */
export function attachGestures(
  surface: Surface,
  emit: (gesture: Gesture) => void,
  policy: GesturePolicy,
): { cancel(): void; destroy(): void } {
  const element = surface.element;
  /** Target radius for tap/hover picking by pointer type, in CSS px. */
  const targetPxFor = (pointerType: string): number =>
    pointerType === 'touch'
      ? Math.max(TOUCH_PICK_RADIUS_PX, policy.pickRadiusPx())
      : policy.pickRadiusPx();
  let state: State = { kind: 'idle', lastTap: null };
  /** The hoverable pointer's latest client position inside the canvas, or null. */
  let probe: { clientX: number; clientY: number; targetPx: number } | null = null;
  let pointerNavigating = false;
  let wheelNavigating = false;
  let wheelEndTimer: ReturnType<typeof setTimeout> | null = null;
  let contextRelease: 'emit' | 'suppress' | null = null;
  let contextReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  const captured = new Set<number>();

  /** Keep a short post-pointerup slot because contextmenu may arrive in a later task. */
  function stageContextRelease(action: 'emit' | 'suppress'): void {
    if (contextReleaseTimer !== null) clearTimeout(contextReleaseTimer);
    contextRelease = action;
    contextReleaseTimer = setTimeout(() => {
      contextRelease = null;
      contextReleaseTimer = null;
    }, CONTEXT_RELEASE_MS);
  }

  /** Clear any state retained for contextmenu disambiguation. */
  function clearContextRelease(): void {
    if (contextReleaseTimer !== null) clearTimeout(contextReleaseTimer);
    contextRelease = null;
    contextReleaseTimer = null;
  }

  function slot(e: PointerEvent, rect: DOMRect): PointerSlot {
    return {
      id: e.pointerId,
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
      clientX: e.clientX,
      clientY: e.clientY,
      type: e.pointerType,
      targetPx: targetPxFor(e.pointerType),
    };
  }

  /** Move a slot to an event's position. */
  function follow(p: PointerSlot, e: PointerEvent, rect: DOMRect): void {
    p.sx = e.clientX - rect.left;
    p.sy = e.clientY - rect.top;
    p.clientX = e.clientX;
    p.clientY = e.clientY;
  }

  function capture(id: number): void {
    try {
      element.setPointerCapture(id);
      captured.add(id);
    } catch {
      /* capture can fail after cancel/up */
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

  /** Emit one aggregate navigation lifecycle across pinch and wheel overlap. */
  function beginNavigation(source: 'pointer' | 'wheel'): void {
    const wasNavigating = pointerNavigating || wheelNavigating;
    if (source === 'pointer') pointerNavigating = true;
    else wheelNavigating = true;
    if (state.kind === 'idle') state.lastTap = null;
    if (!wasNavigating) emit({ kind: 'navigationStart' });
  }

  function endNavigation(source: 'pointer' | 'wheel'): void {
    const wasActive = source === 'pointer' ? pointerNavigating : wheelNavigating;
    if (!wasActive) return;
    if (source === 'pointer') pointerNavigating = false;
    else wheelNavigating = false;
    if (!pointerNavigating && !wheelNavigating) emit({ kind: 'navigationEnd' });
  }

  /** Store a hoverable pointer in client coordinates, invalidating it outside. */
  function updateProbe(e: PointerEvent, rect: DOMRect): void {
    if (!isHoverable(e.pointerType)) return;
    probe = containsClientPoint(rect, e.clientX, e.clientY)
      ? { clientX: e.clientX, clientY: e.clientY, targetPx: targetPxFor(e.pointerType) }
      : null;
  }

  /** The `dragEnd` a cancelled drag emits, at its last position. */
  function cancelledEnd(p: PointerSlot): Gesture {
    return {
      kind: 'dragEnd',
      sx: p.sx,
      sy: p.sy,
      clientX: p.clientX,
      clientY: p.clientY,
      cancelled: true,
    };
  }

  /** Cancel the pointer machine while preserving an overlapping wheel transaction. */
  function cancelPointer(): void {
    const prior = state;
    const wasNavigating = pointerNavigating;
    state = { kind: 'idle', lastTap: null };
    probe = null;
    pointerNavigating = false;
    if (prior.kind === 'contextPressed') stageContextRelease('suppress');
    for (const id of statePointerIds(prior)) release(id);
    if (prior.kind === 'dragging') emit(cancelledEnd(prior.pointer));
    if (wasNavigating && !wheelNavigating) emit({ kind: 'navigationEnd' });
    emit({ kind: 'hoverEnd' });
  }

  /** Cancel every source for blur, page hiding, teardown, and similar resets. */
  function reset(emitGestures: boolean): void {
    const prior = state;
    const wasNavigating = pointerNavigating || wheelNavigating;
    state = { kind: 'idle', lastTap: null };
    probe = null;
    pointerNavigating = false;
    wheelNavigating = false;
    if (wheelEndTimer !== null) clearTimeout(wheelEndTimer);
    wheelEndTimer = null;
    clearContextRelease();
    for (const id of statePointerIds(prior)) release(id);
    captured.clear();
    if (!emitGestures) return;
    if (prior.kind === 'dragging') emit(cancelledEnd(prior.pointer));
    if (wasNavigating) emit({ kind: 'navigationEnd' });
    emit({ kind: 'hoverEnd' });
  }

  function onPointerDown(e: PointerEvent): void {
    const rect = surface.rect();
    updateProbe(e, rect);

    // A secondary press stays inert: released in place it asks for a menu, moved it is nothing.
    if (e.button === 2) {
      if (state.kind !== 'idle') return;
      const p = slot(e, rect);
      capture(p.id);
      clearContextRelease();
      state = {
        kind: 'contextPressed',
        pointer: p,
        startSx: p.sx,
        startSy: p.sy,
        contextEvent: null,
      };
      return;
    }
    if (e.button !== 0 && e.button !== 1) return;

    if (state.kind === 'idle') {
      const p = slot(e, rect);
      const shift = e.shiftKey;
      const mod = e.ctrlKey || e.metaKey;
      capture(p.id);
      state = {
        kind: 'pressed',
        pointer: p,
        button: e.button,
        shift,
        mod,
        startSx: p.sx,
        startSy: p.sy,
        lastTime: e.timeStamp,
        thresholdSq: e.pointerType === 'touch' ? DRAG_TOUCH_SQ : DRAG_MOUSE_SQ,
        lastTap: state.lastTap,
      };
      emit({
        kind: 'press',
        sx: p.sx,
        sy: p.sy,
        button: e.button,
        pointerType: e.pointerType,
        shift,
        mod,
        targetPx: p.targetPx,
      });
      return;
    }

    if ((state.kind === 'pressed' || state.kind === 'dragging') && e.button === 0) {
      // Without navigation a second finger neither pinches nor cancels the first press.
      if (!policy.navigable()) return;
      const first = state.pointer;
      const second = slot(e, rect);
      if (state.kind === 'dragging') emit(cancelledEnd(first));
      capture(first.id);
      capture(second.id);
      state = {
        kind: 'pinching',
        a: first,
        b: second,
        prevDist: distance(first, second),
        prevMidX: (first.sx + second.sx) / 2,
        prevMidY: (first.sy + second.sy) / 2,
      };
      beginNavigation('pointer');
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const rect = surface.rect();
    updateProbe(e, rect);
    if (state.kind === 'pressed' || state.kind === 'dragging') {
      const samples = e.getCoalescedEvents?.();
      followDrag(samples?.length ? samples : [e], rect);
      return;
    }
    processPointerMove(e, rect);
  }

  /**
   * Follow the pressed or dragging pointer through one event's samples. The threshold is tested
   * sample by sample, so a drag starts where and when it would uncoalesced; the drag then reports
   * one `dragMove` from where it stood before the event (the press, for its first) to the last
   * sample.
   */
  function followDrag(samples: readonly PointerEvent[], rect: DOMRect): void {
    let fromSx = 0;
    let fromSy = 0;
    let time = 0;
    if (state.kind === 'dragging') {
      fromSx = state.pointer.sx;
      fromSy = state.pointer.sy;
    }
    for (const e of samples) {
      if (state.kind === 'pressed') {
        const p = state.pointer;
        if (e.pointerId !== p.id) continue;
        follow(p, e, rect);
        const dx = p.sx - state.startSx;
        const dy = p.sy - state.startSy;
        if (dx * dx + dy * dy <= state.thresholdSq) {
          state.lastTime = e.timeStamp;
          continue;
        }
        const { startSx, startSy, lastTime } = state;
        state = { kind: 'dragging', pointer: p };
        fromSx = startSx;
        fromSy = startSy;
        time = e.timeStamp;
        emit({ kind: 'dragStart', sx: startSx, sy: startSy, time: lastTime });
      } else if (state.kind === 'dragging') {
        const p = state.pointer;
        if (e.pointerId !== p.id) continue;
        follow(p, e, rect);
        time = e.timeStamp;
      } else {
        // A `dragStart` handler cancelled or reset the drag; the rest is not a move.
        return;
      }
    }
    if (state.kind !== 'dragging') return;
    const p = state.pointer;
    const dx = p.sx - fromSx;
    const dy = p.sy - fromSy;
    if (dx !== 0 || dy !== 0) emit({ kind: 'dragMove', sx: p.sx, sy: p.sy, dx, dy, time });
  }

  function processPointerMove(e: PointerEvent, rect: DOMRect): void {
    switch (state.kind) {
      case 'idle':
        if (isHoverable(e.pointerType)) {
          emit(probe ? { kind: 'hover', ...probe } : { kind: 'hoverEnd' });
        }
        return;

      case 'pressed':
      case 'dragging':
        followDrag([e], rect);
        return;

      case 'contextPressed': {
        const p = state.pointer;
        if (e.pointerId !== p.id) return;
        follow(p, e, rect);
        const dx = p.sx - state.startSx;
        const dy = p.sy - state.startSy;
        if (dx * dx + dy * dy <= DRAG_MOUSE_SQ) return;
        // A moved secondary press is not a menu request.
        state = { kind: 'idle', lastTap: null };
        release(p.id);
        stageContextRelease('suppress');
        return;
      }

      case 'held':
        if (e.pointerId === state.pointer.id) follow(state.pointer, e, rect);
        return;

      case 'pinching': {
        const { a, b } = state;
        if (e.pointerId === a.id) follow(a, e, rect);
        else if (e.pointerId === b.id) follow(b, e, rect);
        else return;
        const dist = distance(a, b);
        const midX = (a.sx + b.sx) / 2;
        const midY = (a.sy + b.sy) / 2;
        // Pan first so the content under the old midpoint reaches the new one, then zoom there.
        const dx = midX - state.prevMidX;
        const dy = midY - state.prevMidY;
        if (dx !== 0 || dy !== 0) emit({ kind: 'pan', dx, dy });
        if (state.prevDist > 0) {
          const factor = dist / state.prevDist;
          if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
            emit({ kind: 'zoom', factor, sx: midX, sy: midY });
          }
        }
        state.prevDist = dist;
        state.prevMidX = midX;
        state.prevMidY = midY;
        return;
      }

      case 'panning': {
        const p = state.pointer;
        if (e.pointerId !== p.id) return;
        const lastSx = p.sx;
        const lastSy = p.sy;
        follow(p, e, rect);
        const dx = p.sx - lastSx;
        const dy = p.sy - lastSy;
        if (dx !== 0 || dy !== 0) emit({ kind: 'pan', dx, dy });
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

    switch (state.kind) {
      case 'contextPressed': {
        if (e.pointerId !== state.pointer.id) return;
        const contextEvent = state.contextEvent;
        state = { kind: 'idle', lastTap: null };
        release(e.pointerId);
        if (contextEvent) emit({ kind: 'contextmenu', event: contextEvent, keyboard: false });
        else stageContextRelease('emit');
        return;
      }

      case 'pressed': {
        if (e.pointerId !== state.pointer.id) return;
        const { pointer: p, button, shift, mod } = state;
        release(e.pointerId);
        if (button !== 0) {
          state = { kind: 'idle', lastTap: null };
          return;
        }
        const tap = nextTapMemory(state.lastTap, p.sx, p.sy, e.timeStamp, e.pointerType);
        state = { kind: 'idle', lastTap: tap.next };
        if (tap.doubleTap) emit({ kind: 'doubleTap', sx: p.sx, sy: p.sy, targetPx: p.targetPx });
        else emit({ kind: 'tap', sx: p.sx, sy: p.sy, targetPx: p.targetPx, shift, mod });
        return;
      }

      case 'dragging': {
        const p = state.pointer;
        if (e.pointerId !== p.id) return;
        state = { kind: 'idle', lastTap: null };
        release(e.pointerId);
        emit({
          kind: 'dragEnd',
          sx: p.sx,
          sy: p.sy,
          clientX: p.clientX,
          clientY: p.clientY,
          cancelled: false,
        });
        // Hover paused while dragging; the pointer rests somewhere new.
        if (probe && isHoverable(e.pointerType)) emit({ kind: 'hover', ...probe });
        return;
      }

      case 'held':
        if (e.pointerId !== state.pointer.id) return;
        state = { kind: 'idle', lastTap: null };
        release(e.pointerId);
        return;

      case 'pinching': {
        const remaining =
          e.pointerId === state.a.id ? state.b : e.pointerId === state.b.id ? state.a : null;
        if (!remaining) return;
        // The finger left down keeps panning; navigation ends when it lifts.
        state = { kind: 'panning', pointer: remaining };
        release(e.pointerId);
        return;
      }

      case 'panning':
        if (e.pointerId !== state.pointer.id) return;
        state = { kind: 'idle', lastTap: null };
        release(e.pointerId);
        endNavigation('pointer');
        return;

      case 'idle':
        return;

      default:
        /* v8 ignore next -- compile-time exhaustive pointer state guard. */
        assertNever(state);
    }
  }

  function onPointerCancel(e: PointerEvent): void {
    if (!ownsPointer(state, e.pointerId)) return;
    if (state.kind === 'pressed' || state.kind === 'contextPressed' || state.kind === 'held') {
      if (state.kind === 'contextPressed') stageContextRelease('suppress');
      state = { kind: 'idle', lastTap: null };
      probe = null;
      release(e.pointerId);
      emit({ kind: 'hoverEnd' });
      return;
    }
    cancelPointer();
  }

  function onPointerLeave(e: PointerEvent): void {
    if (isHoverable(e.pointerType)) probe = null;
    if (state.kind === 'idle') {
      if (isHoverable(e.pointerType)) emit({ kind: 'hoverEnd' });
      return;
    }
    // Capture keeps a gesture alive outside the element. If capture failed or was lost, leaving
    // must cancel the machine instead of leaving it stuck.
    if (!captured.has(e.pointerId) && ownsPointer(state, e.pointerId)) cancelPointer();
  }

  function onLostPointerCapture(e: PointerEvent): void {
    captured.delete(e.pointerId);
    if (ownsPointer(state, e.pointerId)) cancelPointer();
  }

  /** Suppress the native menu and release only stationary secondary presses. */
  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (state.kind === 'contextPressed') {
      state.contextEvent = e;
      return;
    }
    if (contextRelease !== null) {
      const action = contextRelease;
      clearContextRelease();
      if (action === 'emit') emit({ kind: 'contextmenu', event: e, keyboard: false });
      return;
    }
    // With no secondary-pointer transaction, this is keyboard or assistive input.
    emit({ kind: 'contextmenu', event: e, keyboard: true });
  }

  /** Keep a middle press from starting the browser's autoscroll. */
  function onMouseDown(e: MouseEvent): void {
    if (e.button === 1) e.preventDefault();
  }

  function onWheel(e: WheelEvent): void {
    // Without navigation every wheel stays the page's.
    if (!policy.navigable()) return;
    const gesture = policy.wheel(e);
    // A wheel the policy declines stays the page's: no preventDefault, no transaction.
    if (gesture === 'none') return;
    e.preventDefault();
    const px = pixelsForDelta(e.deltaX, e.deltaMode);
    const py = pixelsForDelta(e.deltaY, e.deltaMode);
    if (!Number.isFinite(px) || !Number.isFinite(py) || (px === 0 && py === 0)) return;

    const rect = surface.rect();
    probe = containsClientPoint(rect, e.clientX, e.clientY)
      ? { clientX: e.clientX, clientY: e.clientY, targetPx: policy.pickRadiusPx() }
      : null;

    const zooming = gesture === 'zoom';
    const factor = zooming ? Math.exp(-py * WHEEL.sensitivity) : 1;
    // Invalid, underflowed, and unit zooms cannot change the camera: no transaction.
    if (zooming && (!Number.isFinite(factor) || factor <= 0 || factor === 1)) return;
    // A pinch owns the pan; a wheel pan must not fight it.
    if (!zooming && pointerNavigating) return;

    beginNavigation('wheel');
    if (wheelEndTimer !== null) clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      wheelEndTimer = null;
      endNavigation('wheel');
    }, WHEEL.endMs);

    if (zooming) {
      emit({ kind: 'zoom', factor, sx: e.clientX - rect.left, sy: e.clientY - rect.top });
    } else {
      emit({ kind: 'pan', dx: -px, dy: -py });
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
  element.addEventListener('contextmenu', onContextMenu);
  element.addEventListener('mousedown', onMouseDown);
  element.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    /** End an in-flight drag as cancelled; the pointer is ignored until it is released. */
    cancel() {
      if (state.kind === 'dragging') {
        const p = state.pointer;
        state = { kind: 'held', pointer: p };
        emit(cancelledEnd(p));
      } else if (state.kind === 'pressed') {
        state = { kind: 'held', pointer: state.pointer };
      }
    },
    /** Detach listeners, release captures, and reset gesture state. */
    destroy() {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerCancel);
      element.removeEventListener('pointerleave', onPointerLeave);
      element.removeEventListener('lostpointercapture', onLostPointerCapture);
      element.removeEventListener('contextmenu', onContextMenu);
      element.removeEventListener('mousedown', onMouseDown);
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reset(false);
    },
  };
}

/** Whether a pointer type can hover. */
function isHoverable(pointerType: string): boolean {
  return pointerType === 'mouse' || pointerType === 'pen';
}

/** Euclidean distance between two active pointers in CSS px. */
function distance(a: PointerSlot, b: PointerSlot): number {
  return Math.hypot(b.sx - a.sx, b.sy - a.sy);
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

/** Whether one active state owns a pointer id. */
function ownsPointer(state: State, pointerId: number): boolean {
  if (state.kind === 'idle') return false;
  if (state.kind === 'pinching') return state.a.id === pointerId || state.b.id === pointerId;
  return state.pointer.id === pointerId;
}

/** Owned pointer ids, snapshotted before a transition to idle. */
function statePointerIds(state: State): number[] {
  if (state.kind === 'idle') return [];
  if (state.kind === 'pinching') return [state.a.id, state.b.id];
  return [state.pointer.id];
}

/** Update tap memory and report whether the current tap is a double tap. */
function nextTapMemory(
  lastTap: LastTap | null,
  sx: number,
  sy: number,
  time: number,
  pointerType: string,
): { next: LastTap | null; doubleTap: boolean } {
  const dx = lastTap ? sx - lastTap.sx : Infinity;
  const dy = lastTap ? sy - lastTap.sy : Infinity;
  const doubleTap =
    !!lastTap &&
    pointerType === lastTap.pointerType &&
    time >= lastTap.time &&
    time - lastTap.time < POINTER.doubleTapMs &&
    dx * dx + dy * dy < DOUBLE_TAP_SQ;
  return { next: doubleTap ? null : { time, sx, sy, pointerType }, doubleTap };
}

/** Exhaustiveness guard for pointer state switches. */
/* v8 ignore next 3 -- called only if the typed State union stops being exhaustive. */
function assertNever(x: never): never {
  throw new Error(`unreachable pointer state: ${JSON.stringify(x)}`);
}
