import { interactions, type Monitor } from './monitor.js';
import { createCanvasInput, inputModifiers, wheelDelta } from '@latkit/gpu';
export interface InputOptions {
  readonly monitor: Monitor;
  readonly canvas: HTMLCanvasElement;
  readonly interaction?: 'navigate' | 'inspect' | 'none';
  readonly wheel?: 'zoom' | 'modifier';
  readonly keyboard?: boolean;
}
/** Shared GPU normalization/capture/budgets; monitor owns its gestures and raw-sample refinement. */
export function attachMonitorInput(options: InputOptions): () => void {
  const { monitor, canvas, interaction = 'navigate' } = options;
  const input = createCanvasInput({
    canvas,
    keyboard: options.keyboard,
    touchAction: interaction === 'navigate' ? 'none' : undefined,
  });
  const listener = { signal: input.signal },
    points = new Map<number, readonly [number, number]>();
  let start: readonly [number, number] | undefined,
    moved = false,
    picking: AbortController | undefined;
  const read = async (point: readonly [number, number]) => {
    picking?.abort();
    const request = new AbortController();
    picking = request;
    try {
      return await monitor.hitTest(point, {
        signal: AbortSignal.any([input.signal, request.signal]),
      });
    } catch {
      return null;
    }
  };
  const midpoint = () => {
    const p = [...points.values()];
    return [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2] as const;
  };
  const distance = () => {
    const p = [...points.values()];
    return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (interaction === 'none' || event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      const point = input.point(event);
      points.set(event.pointerId, point);
      input.capture(event.pointerId);
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
      if (interaction === 'none') return;
      const point = input.point(event),
        previous = points.get(event.pointerId);
      if (!previous) {
        monitor.setPointer(point);
        return;
      }
      const center = points.size === 2 ? midpoint() : undefined,
        oldDistance = points.size === 2 ? distance() : 0;
      points.set(event.pointerId, point);
      if (start && Math.hypot(point[0] - start[0], point[1] - start[1]) > 3) moved = true;
      if (interaction === 'navigate') {
        if (center) {
          const next = midpoint();
          monitor.panBy(next[0] - center[0], next[1] - center[1]);
          const d = distance();
          if (d && oldDistance) monitor.zoomBy(d / oldDistance, next);
        } else monitor.panBy(point[0] - previous[0], point[1] - previous[1]);
      }
    },
    listener,
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      if (!points.has(event.pointerId)) return;
      const point = input.point(event);
      points.delete(event.pointerId);
      input.release(event.pointerId);
      if (!moved && interaction !== 'none')
        void read(point).then((items) => {
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
      if (!points.size) monitor.setPointer(null);
    },
    listener,
  );
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (
        interaction !== 'navigate' ||
        (options.wheel === 'modifier' && !event.ctrlKey && !event.metaKey)
      )
        return;
      event.preventDefault();
      monitor.zoomBy(
        Math.exp(
          -Math.max(-1000, Math.min(1000, wheelDelta(event, { height: canvas.clientHeight }))) *
            0.002,
        ),
        input.point(event),
      );
    },
    { ...listener, passive: false },
  );
  canvas.addEventListener(
    'dblclick',
    () => {
      if (interaction === 'navigate') monitor.fit();
    },
    listener,
  );
  canvas.addEventListener(
    'contextmenu',
    (event) => {
      if (interaction === 'none') return;
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
        if (interaction === 'none') return;
        const actions: Record<string, () => void> = { Escape: () => monitor.select(null) };
        if (interaction === 'navigate')
          Object.assign(actions, {
            Home: () => monitor.fit(),
            '+': () => monitor.zoomBy(1.25),
            '=': () => monitor.zoomBy(1.25),
            '-': () => monitor.zoomBy(0.8),
            ArrowLeft: () => monitor.panBy(40, 0),
            ArrowRight: () => monitor.panBy(-40, 0),
            ArrowUp: () => monitor.panBy(0, 40),
            ArrowDown: () => monitor.panBy(0, -40),
          });
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
    if(input.signal.aborted)return;
    picking?.abort();
    input.destroy();
    points.clear();
    if(interactions.has(monitor))monitor.setPointer(null);
  };
}
