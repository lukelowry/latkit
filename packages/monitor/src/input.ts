import type { kit, Point, ViewInput } from '@latkit/gpu';

/** What a monitor's own gestures drive; the view implements it. */
export interface Gestures {
  pan(dx: number, dy: number): void;
  /** Select the nearest reading at a point, or nothing. */
  click(point: Point, signal: AbortSignal): void;
}

/** Click selects the nearest reading; navigating, a drag pans. */
export function listen(
  canvas: HTMLCanvasElement,
  input: kit.CanvasInput,
  mode: NonNullable<ViewInput['mode']>,
  view: Gestures,
): void {
  const { signal, point } = input,
    navigate = mode !== 'inspect',
    points = new Map<number, Point>();
  let start: Point | undefined,
    moved = false,
    picking: AbortController | undefined;
  const cancel = () => {
    points.clear();
    start = undefined;
    moved = true;
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      const p = point(event);
      points.set(event.pointerId, p);
      if (points.size === 1) {
        start = p;
        moved = false;
      } else moved = true;
      if (navigate) input.capture(event.pointerId);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const previous = points.get(event.pointerId);
      if (!previous) return;
      const p = point(event);
      points.set(event.pointerId, p);
      if (start && Math.hypot(p[0] - start[0], p[1] - start[1]) > 3) moved = true;
      if (navigate && moved && points.size === 1) view.pan(p[0] - previous[0], p[1] - previous[1]);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      if (!points.has(event.pointerId)) return;
      const p = point(event);
      points.delete(event.pointerId);
      if (!moved) {
        picking?.abort();
        picking = new AbortController();
        view.click(p, AbortSignal.any([signal, picking.signal]));
      }
      if (!points.size) start = undefined;
    },
    { signal },
  );
  canvas.addEventListener('pointercancel', cancel, { signal });
  canvas.addEventListener(
    'lostpointercapture',
    (event) => {
      if (points.has(event.pointerId)) cancel();
    },
    { signal },
  );
  canvas.addEventListener('pointerleave', cancel, { signal });
  signal.addEventListener('abort', () => picking?.abort(), { once: true });
}
