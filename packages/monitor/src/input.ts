import { interactions, type Monitor } from './monitor.js';
import { createCanvasInput, inputModifiers } from '@latkit/gpu';
export interface InputOptions {
  readonly monitor: Monitor;
  readonly canvas: HTMLCanvasElement;
  readonly keyboard?: boolean;
}
/** Inspection only. Wheel and touch scrolling remain browser behavior. */
export function attachMonitorInput(options: InputOptions): () => void {
  const { monitor, canvas } = options;
  const input = createCanvasInput({
    canvas,
    keyboard: options.keyboard,
  });
  const listener = { signal: input.signal },
    points = new Map<number, readonly [number, number]>();
  let start: readonly [number, number] | undefined,
    moved = false,
    picking: AbortController | undefined;
  const read = async (point: readonly [number, number], limit = 16) => {
    picking?.abort();
    const request = new AbortController();
    picking = request;
    try {
      return await monitor.hitTest(point, {
        limit,
        signal: AbortSignal.any([input.signal, request.signal]),
      });
    } catch {
      return null;
    }
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      const point = input.point(event);
      points.set(event.pointerId, point);
      if (points.size === 1) {
        start = point;
        moved = false;
      } else moved = true;
      monitor.setPointer(null);
    },
    listener,
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const point = input.point(event),
        previous = points.get(event.pointerId);
      if (!previous) {
        monitor.setPointer(point);
        return;
      }
      points.set(event.pointerId, point);
      if (start && Math.hypot(point[0] - start[0], point[1] - start[1]) > 3) moved = true;
    },
    listener,
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      if (!points.has(event.pointerId)) return;
      const point = input.point(event);
      points.delete(event.pointerId);
      if (!moved)
        void read(point, 1).then((items) => {
          if (input.signal.aborted || !items) return;
          const item = items[0] ?? null;
          monitor.select(item);
          interactions.get(monitor)?.select(item);
        });
      if (!points.size) {
        start = undefined;
        monitor.setPointer(point);
      }
    },
    listener,
  );
  const cancel = (event: PointerEvent) => {
    points.delete(event.pointerId);
    start = undefined;
    moved = true;
    monitor.setPointer(null);
  };
  canvas.addEventListener('pointercancel', cancel, listener);
  canvas.addEventListener(
    'lostpointercapture',
    (event) => {
      if (points.has(event.pointerId)) cancel(event);
    },
    listener,
  );
  canvas.addEventListener(
    'pointerleave',
    () => {
      points.clear();
      start = undefined;
      moved = true;
      monitor.setPointer(null);
    },
    listener,
  );
  canvas.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      const point = input.point(event);
      void read(point).then((items) => {
        if (!input.signal.aborted && items)
          interactions
            .get(monitor)
            ?.context({ point, items, trigger: 'pointer', modifiers: inputModifiers(event) });
      });
    },
    listener,
  );
  if (options.keyboard !== false)
    canvas.addEventListener(
      'keydown',
      (event) => {
        const actions: Record<string, () => void> = { Escape: () => monitor.select(null) };
        if (actions[event.key]) {
          event.preventDefault();
          actions[event.key]();
        }
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault();
          const point = [canvas.clientWidth / 2, canvas.clientHeight / 2] as const;
          void read(point).then((items) => {
            if (!input.signal.aborted && items)
              interactions
                .get(monitor)
                ?.context({ point, items, trigger: 'keyboard', modifiers: inputModifiers(event) });
          });
        }
      },
      listener,
    );
  return () => {
    if (input.signal.aborted) return;
    picking?.abort();
    input.destroy();
    points.clear();
    if (interactions.has(monitor)) monitor.setPointer(null);
  };
}
