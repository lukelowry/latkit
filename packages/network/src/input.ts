import type { kit, Point, ViewInput } from '@latkit/gpu';
import { sameItem, type NetworkItem } from './data.js';

type Mode = NonNullable<ViewInput['mode']>;
/** What a network's own gestures drive; the view implements it. */
export interface Gestures {
  pan(dx: number, dy: number): void;
  rotate(dx: number, dy: number): void;
  /** Hits at a point, nearest first, once the shown frame can answer. */
  hits(point: Point, signal: AbortSignal): Promise<readonly NetworkItem[]>;
  /** Report a failure no caller awaits. */
  fail(error: unknown): void;
  locate(item: NetworkItem): Point | null;
  neighborhood(item: NetworkItem): readonly NetworkItem[];
  reveal(item: NetworkItem): void;
  selection(): readonly NetworkItem[];
  /** Select as the user did, reporting it. */
  choose(items: readonly NetworkItem[]): void;
}

/** Drag pans, or turns with the right button or Shift; click selects, cycling through overlaps. */
export function listen(
  canvas: HTMLCanvasElement,
  input: kit.CanvasInput,
  mode: Mode,
  view: Gestures,
): void {
  const { signal, point } = input,
    navigate = mode !== 'inspect';
  let drag:
    | { id: number; x: number; y: number; startX: number; startY: number; rotate: boolean }
    | undefined;
  let cycle = 0,
    lastPoint: Point | undefined,
    picking: AbortController | undefined;
  /** A modifier toggles the hit instead of replacing the selection; a newer click wins. */
  const choose = (p: Point, toggle: boolean) => {
    cycle = lastPoint && Math.hypot(p[0] - lastPoint[0], p[1] - lastPoint[1]) < 3 ? cycle + 1 : 0;
    lastPoint = p;
    const turn = cycle;
    picking?.abort();
    const own = (picking = new AbortController()),
      stop = AbortSignal.any([signal, own.signal]);
    view.hits(p, stop).then(
      (hits) => {
        if (stop.aborted) return;
        const hit = hits.length ? hits[turn % hits.length] : undefined;
        if (!toggle) view.choose(hit ? [hit] : []);
        else if (hit) {
          const selection = view.selection(),
            rest = selection.filter((item) => !sameItem(item, hit));
          view.choose(rest.length === selection.length ? [...rest, hit] : rest);
        }
      },
      (error: unknown) => {
        if (!stop.aborted) view.fail(error);
      },
    );
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      const p = point(event);
      drag = {
        id: event.pointerId,
        x: p[0],
        y: p[1],
        startX: p[0],
        startY: p[1],
        rotate: event.button === 2 || event.shiftKey,
      };
      if (navigate) input.capture(event.pointerId);
      canvas.focus({ preventScroll: true });
    },
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (drag?.id !== event.pointerId || !navigate) return;
      const p = point(event),
        dx = p[0] - drag.x,
        dy = p[1] - drag.y;
      if (drag.rotate) view.rotate(dx, dy);
      else view.pan(dx, dy);
      drag.x = p[0];
      drag.y = p[1];
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      if (drag?.id !== event.pointerId) return;
      const p = point(event);
      if (Math.hypot(p[0] - drag.startX, p[1] - drag.startY) < 4 && event.button === 0)
        choose(p, event.shiftKey || event.ctrlKey || event.metaKey);
      drag = undefined;
      input.release(event.pointerId);
    },
    { signal },
  );
  canvas.addEventListener('pointercancel', () => (drag = undefined), { signal });
}

/** Arrows pan, or turn with Shift; inspecting, they step to the neighbor in that direction. */
export function arrow(event: KeyboardEvent, mode: Mode, view: Gestures): boolean {
  const key = event.key;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown')
    return false;
  const dx = key === 'ArrowLeft' ? 24 : key === 'ArrowRight' ? -24 : 0,
    dy = key === 'ArrowUp' ? 24 : key === 'ArrowDown' ? -24 : 0;
  if (mode !== 'inspect') {
    if (event.shiftKey) view.rotate(dx, dy);
    else view.pan(dx, dy);
    return true;
  }
  const selected = view.selection().at(-1),
    origin = selected && view.locate(selected);
  if (!selected || !origin) return true;
  let best: NetworkItem | undefined,
    score = Infinity;
  for (const item of view.neighborhood(selected)) {
    const p = view.locate(item);
    if (!p) continue;
    const x = p[0] - origin[0],
      y = p[1] - origin[1],
      dot = -(x * dx + y * dy);
    if (dot <= 0) continue;
    const s = Math.hypot(x, y) ** 2 / dot;
    if (s < score) {
      score = s;
      best = item;
    }
  }
  if (best) {
    view.choose([best]);
    view.reveal(best);
  }
  return true;
}
