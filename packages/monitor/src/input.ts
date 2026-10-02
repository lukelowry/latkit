import { kit } from '@latkit/gpu';
import type { Reading } from './data.js';

type Point = readonly [number, number];
export interface MonitorInput {
  /** `inspect` hovers and selects; wheel and touch scrolling stay with the page. */
  readonly mode?: 'inspect' | 'none';
  readonly keyboard?: boolean;
}
/** What input drives; the view implements it. */
export interface Controls {
  pointer(point: Point | null): void;
  pick(
    point: Point,
    options: { readonly limit: number; readonly signal: AbortSignal },
  ): Promise<readonly Reading[]>;
  /** Select as the user did, reporting it. */
  choose(items: readonly Reading[]): void;
  menu(menu: kit.ContextMenu<Reading>): void;
}

export function attachInput(
  canvas: HTMLCanvasElement,
  options: MonitorInput,
  view: Controls,
): () => void {
  const input = kit.createCanvasInput({ canvas, keyboard: options.keyboard });
  const listener = { signal: input.signal },
    points = new Map<number, Point>();
  let start: Point | undefined,
    moved = false,
    picking: AbortController | undefined;
  const read = async (point: Point, limit = 16) => {
    picking?.abort();
    const request = new AbortController();
    picking = request;
    try {
      return await view.pick(point, {
        limit,
        signal: AbortSignal.any([input.signal, request.signal]),
      });
    } catch {
      return null;
    }
  };
  const menu = (point: Point, trigger: 'pointer' | 'keyboard', event: KeyboardEvent | MouseEvent) =>
    void read(point).then((items) => {
      if (!input.signal.aborted && items)
        view.menu({ point, items, trigger, modifiers: kit.inputModifiers(event) });
    });
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
      view.pointer(null);
    },
    listener,
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const point = input.point(event),
        previous = points.get(event.pointerId);
      if (!previous) {
        view.pointer(point);
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
          if (!input.signal.aborted && items) view.choose(items.slice(0, 1));
        });
      if (!points.size) {
        start = undefined;
        view.pointer(point);
      }
    },
    listener,
  );
  const cancel = (event: PointerEvent) => {
    points.delete(event.pointerId);
    start = undefined;
    moved = true;
    view.pointer(null);
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
      view.pointer(null);
    },
    listener,
  );
  canvas.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      menu(input.point(event), 'pointer', event);
    },
    listener,
  );
  if (options.keyboard !== false)
    canvas.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') view.choose([]);
        else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
          menu([canvas.clientWidth / 2, canvas.clientHeight / 2], 'keyboard', event);
        else return;
        event.preventDefault();
      },
      listener,
    );
  return () => {
    picking?.abort();
    input.destroy();
    points.clear();
    view.pointer(null);
  };
}
