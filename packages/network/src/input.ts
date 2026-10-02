import { kit } from '@latkit/gpu';
import { sameItem, type NetworkItem } from './data.js';

type Point = readonly [number, number];
export interface NetworkInput {
  /** `navigate` pans, zooms, and turns; `inspect` only hovers and selects. */
  readonly mode?: 'navigate' | 'inspect' | 'none';
  /** Zoom on every wheel, or only with Ctrl or ⌘. */
  readonly wheel?: 'zoom' | 'modifier';
  readonly keyboard?: boolean;
}
/** What input drives; the view implements it. */
export interface Controls {
  pointer(point: Point | null): void;
  pan(dx: number, dy: number): void;
  rotate(dx: number, dy: number): void;
  zoom(factor: number, anchor?: Point): void;
  fit(): void;
  hit(point: Point): readonly NetworkItem[];
  locate(item: NetworkItem): Point | null;
  neighborhood(item: NetworkItem): readonly NetworkItem[];
  reveal(item: NetworkItem): void;
  selection(): readonly NetworkItem[];
  /** Select as the user did, reporting it. */
  choose(items: readonly NetworkItem[]): void;
  menu(menu: kit.ContextMenu<NetworkItem>): void;
}

export function attachInput(
  canvas: HTMLCanvasElement,
  options: NetworkInput,
  view: Controls,
): () => void {
  const mode = options.mode ?? 'navigate';
  const input = kit.createCanvasInput({
      canvas,
      keyboard: options.keyboard,
      touchAction: mode === 'navigate' ? 'none' : 'pan-x pan-y',
    }),
    { signal, point } = input;
  let drag:
    | { id: number; x: number; y: number; startX: number; startY: number; rotate: boolean }
    | undefined;
  let cycle = 0,
    lastPoint: Point | undefined;
  /** Click selects the nearest item, cycling through overlaps; a modifier toggles it instead. */
  const choose = (p: Point, toggle: boolean) => {
    const hits = view.hit(p);
    cycle = lastPoint && Math.hypot(p[0] - lastPoint[0], p[1] - lastPoint[1]) < 3 ? cycle + 1 : 0;
    lastPoint = p;
    const hit = hits.length ? hits[cycle % hits.length] : undefined;
    if (!toggle) view.choose(hit ? [hit] : []);
    else if (hit) {
      const selection = view.selection(),
        rest = selection.filter((item) => !sameItem(item, hit));
      view.choose(rest.length === selection.length ? [...rest, hit] : rest);
    }
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
      if (mode === 'navigate') input.capture(event.pointerId);
      canvas.focus({ preventScroll: true });
    },
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const p = point(event);
      view.pointer(p);
      if (drag?.id === event.pointerId && mode === 'navigate') {
        const dx = p[0] - drag.x,
          dy = p[1] - drag.y;
        if (drag.rotate) view.rotate(dx, dy);
        else view.pan(dx, dy);
        drag.x = p[0];
        drag.y = p[1];
      }
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
  canvas.addEventListener(
    'pointercancel',
    () => {
      drag = undefined;
      view.pointer(null);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerleave',
    () => {
      if (!drag) view.pointer(null);
    },
    { signal },
  );
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (mode !== 'navigate' || (options.wheel === 'modifier' && !event.ctrlKey && !event.metaKey))
        return;
      event.preventDefault();
      const delta = kit.wheelDelta(event, { height: canvas.clientHeight });
      view.zoom(Math.exp(-Math.max(-1000, Math.min(1000, delta)) * 0.002), point(event));
    },
    { signal, passive: false },
  );
  canvas.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      const p = point(event);
      view.menu({
        point: p,
        items: view.hit(p),
        trigger: 'pointer',
        modifiers: kit.inputModifiers(event),
      });
    },
    { signal },
  );
  if (options.keyboard !== false)
    canvas.addEventListener(
      'keydown',
      (event) => {
        const selected = view.selection().at(-1);
        if (event.key === 'Escape') view.choose([]);
        else if (event.key === 'Home') view.fit();
        else if (event.key === '+' || event.key === '=') view.zoom(1.2);
        else if (event.key === '-') view.zoom(1 / 1.2);
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          const dx = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0,
            dy = event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0;
          if (mode === 'navigate') {
            if (event.shiftKey) view.rotate(dx, dy);
            else view.pan(dx, dy);
          } else if (selected) {
            // Step to the neighbor most nearly in the arrow's direction.
            const origin = view.locate(selected);
            if (origin) {
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
            }
          }
        } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          const at = (selected && view.locate(selected)) ?? [
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ];
          view.menu({
            point: at,
            items: view.hit(at),
            trigger: 'keyboard',
            modifiers: kit.inputModifiers(event),
          });
        } else return;
        event.preventDefault();
      },
      { signal },
    );
  return () => input.destroy();
}
