import type { Network, NetworkEvents } from './network.js';
import { notifyInput } from './network.js';
export interface InputOptions {
  readonly network: Network;
  readonly canvas: HTMLCanvasElement;
  readonly interaction?: 'navigate' | 'inspect' | 'none';
  readonly wheel?: 'zoom' | 'modifier';
  readonly keyboard?: boolean;
}
export function attachNetworkInput(options: InputOptions): () => void {
  const { network, canvas } = options,
    mode = options.interaction ?? 'navigate';
  if (mode === 'none') return () => {};
  const controller = new AbortController(),
    signal = controller.signal;
  const tab = canvas.getAttribute('tabindex'),
    touch = canvas.style.touchAction;
  if (options.keyboard !== false && !canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  canvas.style.touchAction = mode === 'navigate' ? 'none' : 'pan-x pan-y';
  const point = (event: { clientX: number; clientY: number }): readonly [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [event.clientX - r.left, event.clientY - r.top];
  };
  let drag:
    | { id: number; x: number; y: number; startX: number; startY: number; rotate: boolean }
    | undefined;
  let selected: import('./data.js').NetworkItem | null = null,
    cycle = 0,
    lastPoint: readonly [number, number] | undefined;
  const choose = (p: readonly [number, number]) => {
    const hits = network.hitTest(p);
    cycle = lastPoint && Math.hypot(p[0] - lastPoint[0], p[1] - lastPoint[1]) < 3 ? cycle + 1 : 0;
    lastPoint = p;
    selected = hits.length ? hits[cycle % hits.length] : null;
    network.select(selected);
    notifyInput(network, 'select', selected);
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
      if (mode === 'navigate') canvas.setPointerCapture(event.pointerId);
      canvas.focus({ preventScroll: true });
    },
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const p = point(event);
      network.setPointer(p);
      if (drag?.id === event.pointerId && mode === 'navigate') {
        const dx = p[0] - drag.x,
          dy = p[1] - drag.y;
        if (drag.rotate) network.rotateBy(dx, dy);
        else network.panBy(dx, dy);
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
      if (Math.hypot(p[0] - drag.startX, p[1] - drag.startY) < 4 && event.button === 0) choose(p);
      drag = undefined;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointercancel',
    () => {
      drag = undefined;
      network.setPointer(null);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerleave',
    () => {
      if (!drag) network.setPointer(null);
    },
    { signal },
  );
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (mode !== 'navigate' || (options.wheel === 'modifier' && !event.ctrlKey && !event.metaKey))
        return;
      event.preventDefault();
      network.zoomBy(
        Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.04 : 0.002)),
        point(event),
      );
    },
    { signal, passive: false },
  );
  canvas.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      const p = point(event);
      notifyInput(network, 'contextmenu', { point: p, items: network.hitTest(p), event });
    },
    { signal },
  );
  if (options.keyboard !== false)
    canvas.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          selected = null;
          network.select(null);
          notifyInput(network, 'select', null);
        } else if (event.key === 'Home') network.fit({ animate: true });
        else if (event.key === '+' || event.key === '=') network.zoomBy(1.2);
        else if (event.key === '-') network.zoomBy(1 / 1.2);
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          const dx = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0,
            dy = event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0;
          if (mode === 'navigate') {
            if (event.shiftKey) network.rotateBy(dx, dy);
            else network.panBy(dx, dy);
          } else if (selected) {
            const origin = network.locate(selected);
            if (origin) {
              let best: typeof selected | null = null,
                score = Infinity;
              for (const item of network.neighborhood(selected)) {
                const p = network.locate(item);
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
                selected = best;
                network.select(best);
                notifyInput(network, 'select', best);
                network.reveal(best);
              }
            }
          }
        } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          const p = selected ? network.locate(selected) : null;
          const at = p ?? ([canvas.clientWidth / 2, canvas.clientHeight / 2] as const);
          notifyInput(network, 'contextmenu', {
            point: at,
            items: network.hitTest(at),
            event,
          } satisfies NetworkEvents['contextmenu']);
        } else return;
        event.preventDefault();
      },
      { signal },
    );
  return () => {
    controller.abort();
    if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    canvas.style.touchAction = touch;
    if (tab === null) canvas.removeAttribute('tabindex');
    else canvas.setAttribute('tabindex', tab);
  };
}
