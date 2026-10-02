import type { kit, Point } from '@latkit/gpu';

/** What a monitor's own gesture drives; the view implements it. */
export interface Gestures {
  /** Select the nearest reading at a point, or nothing. */
  click(point: Point, signal: AbortSignal): void;
}

/** A click selects the nearest reading; the monitor has no pointer navigation. */
export function listen(canvas: HTMLCanvasElement, input: kit.CanvasInput, view: Gestures): void {
  const { signal, point } = input;
  // The pointer pressed, and where; a second pointer cancels the click.
  let start: { readonly id: number; readonly point: Point } | undefined,
    picking: AbortController | undefined;
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      start = start ? undefined : { id: event.pointerId, point: point(event) };
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      const p = point(event);
      if (
        start?.id === event.pointerId &&
        Math.hypot(p[0] - start.point[0], p[1] - start.point[1]) <= 3
      ) {
        picking?.abort();
        picking = new AbortController();
        view.click(p, AbortSignal.any([signal, picking.signal]));
      }
      start = undefined;
    },
    { signal },
  );
  for (const type of ['pointercancel', 'pointerleave'] as const)
    canvas.addEventListener(type, () => (start = undefined), { signal });
  signal.addEventListener('abort', () => picking?.abort(), { once: true });
}
