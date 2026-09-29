interface Point {
  x: number;
  y: number;
}
interface Actions {
  enabled(): boolean;
  contains(x: number, y: number): boolean;
  pan(dx: number, dy: number): void;
  zoom(factor: number, anchor: { clientX: number; clientY: number }): void;
  pick(event: PointerEvent): void;
  settled(): void;
}

/** Own pointer capture and browser gesture policy; data and GPU work stay with the controller. */
export function createInteraction(canvas: HTMLCanvasElement, actions: Actions) {
  const pointers = new Map<number, Point>();
  let origin: Point | null = null;
  let dragging = false;
  let enabled = false;
  let previousTouchAction = '';
  const center = (): Point => {
    const points = [...pointers.values()];
    return points.length === 2
      ? { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 }
      : points[0]!;
  };
  const distance = () => {
    const [a, b] = [...pointers.values()];
    return b ? Math.hypot(b.x - a!.x, b.y - a!.y) : 0;
  };
  const release = (id: number) => {
    if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
  };
  const cancel = () => {
    const ids = [...pointers.keys()];
    pointers.clear();
    origin = null;
    dragging = false;
    for (const id of ids) release(id);
    actions.settled();
  };
  const sync = () => {
    const next = actions.enabled();
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      previousTouchAction = canvas.style.touchAction;
      canvas.style.touchAction = 'none';
    } else {
      canvas.style.touchAction = previousTouchAction;
      cancel();
    }
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (!enabled) {
      actions.pick(event);
      return;
    }
    if (!actions.contains(event.clientX, event.clientY) || pointers.size === 2) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, point);
    if (pointers.size === 1) {
      origin = point;
      dragging = false;
    } else dragging = true;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const before = center(),
      beforeDistance = distance();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = center();
    if (!dragging && origin && Math.hypot(after.x - origin.x, after.y - origin.y) < 4) return;
    const from = dragging ? before : origin!;
    dragging = true;
    actions.pan(after.x - from.x, after.y - from.y);
    const afterDistance = distance();
    if (beforeDistance > 0 && afterDistance > 0)
      actions.zoom(afterDistance / beforeDistance, { clientX: after.x, clientY: after.y });
    event.preventDefault();
  };
  const up = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const pick = !dragging && event.type === 'pointerup';
    pointers.delete(event.pointerId);
    release(event.pointerId);
    if (!pointers.size) {
      origin = null;
      dragging = false;
      actions.settled();
      if (pick) actions.pick(event);
    }
  };
  const wheel = (event: WheelEvent) => {
    if (!enabled || !actions.contains(event.clientX, event.clientY)) return;
    const pixels =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    if (!Number.isFinite(pixels) || pixels === 0) return;
    event.preventDefault();
    actions.zoom(Math.exp(-Math.max(-600, Math.min(600, pixels)) * 0.002), event);
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  sync();
  return {
    get active() {
      return pointers.size > 0;
    },
    sync,
    cancel,
    destroy() {
      cancel();
      if (enabled) canvas.style.touchAction = previousTouchAction;
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('lostpointercapture', up);
      canvas.removeEventListener('wheel', wheel);
    },
  };
}
