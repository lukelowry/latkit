import type { Viewport } from '../frame/render.js';
export interface Modifiers {
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}
export interface ContextMenu<T> {
  readonly point: readonly [number, number];
  readonly items: readonly T[];
  readonly trigger: 'pointer' | 'keyboard';
  readonly modifiers: Modifiers;
}
export interface HoverOptions {
  readonly hover?: 'auto' | 'on' | 'off';
  readonly hoverBudgetMs?: number;
}
export type HoverState = 'off' | 'idle' | 'active' | 'moving' | 'budget';
export function inputModifiers(
  event: Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): Modifiers {
  return { alt: event.altKey, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey };
}
/** Local CSS pixels, including axis-aligned CSS scaling and element borders. */
export function localPoint(
  element: HTMLElement,
  event: { readonly clientX: number; readonly clientY: number },
): readonly [number, number] {
  const rect = element.getBoundingClientRect();
  const sx = rect.width / (element.offsetWidth || rect.width),
    sy = rect.height / (element.offsetHeight || rect.height);
  return [
    (event.clientX - rect.left) / sx - element.clientLeft,
    (event.clientY - rect.top) / sy - element.clientTop,
  ];
}
export function wheelDelta(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  viewport: Pick<Viewport, 'height'>,
): number {
  return event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? viewport.height : 1);
}
export interface CanvasInput {
  readonly signal: AbortSignal;
  point(event: { readonly clientX: number; readonly clientY: number }): readonly [number, number];
  capture(pointerId: number): void;
  release(pointerId: number): void;
  destroy(): void;
}
/** Owns DOM listener/capture lifetime only. Gestures and hit testing remain renderer-specific. */
export function createCanvasInput(options: {
  readonly canvas: HTMLCanvasElement;
  readonly keyboard?: boolean;
  readonly touchAction?: string;
}): CanvasInput {
  const { canvas } = options,
    controller = new AbortController(),
    captured = new Set<number>(),
    tab = canvas.getAttribute('tabindex'),
    touch = canvas.style.touchAction;
  let destroyed = false;
  if (options.keyboard !== false && tab === null) canvas.tabIndex = 0;
  if (options.touchAction !== undefined) canvas.style.touchAction = options.touchAction;
  const release = (id: number): void => {
    captured.delete(id);
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  canvas.addEventListener('lostpointercapture', (event) => captured.delete(event.pointerId), {
    signal: controller.signal,
  });
  canvas.addEventListener('pointercancel', (event) => release(event.pointerId), {
    signal: controller.signal,
  });
  return {
    signal: controller.signal,
    point: (event) => localPoint(canvas, event),
    capture(id) {
      if (!destroyed) {
        canvas.setPointerCapture(id);
        captured.add(id);
      }
    },
    release,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controller.abort();
      for (const id of captured) release(id);
      canvas.style.touchAction = touch;
      if (tab === null) canvas.removeAttribute('tabindex');
      else canvas.setAttribute('tabindex', tab);
    },
  };
}
export type BudgetResult<T> =
  | { readonly complete: true; readonly value: T; readonly elapsedMs: number }
  | { readonly complete: false; readonly elapsedMs: number };
/** Cooperative checkpoint. Incomplete searches never publish a partial nearest-hit result. */
export function withinBudget<T>(
  work: (checkpoint: () => void) => T,
  budgetMs?: number,
): BudgetResult<T> {
  if (budgetMs !== undefined && (!Number.isFinite(budgetMs) || budgetMs <= 0))
    throw new RangeError('Budget must be positive');
  const started = performance.now(),
    deadline = budgetMs === undefined ? Infinity : started + budgetMs,
    exhausted = new Error('Work budget exhausted');
  let count = 0;
  const check =
    budgetMs === undefined
      ? () => {}
      : () => {
          if ((count++ & 31) === 0 && performance.now() >= deadline) throw exhausted;
        };
  try {
    const value = work(check),
      elapsedMs = performance.now() - started;
    return elapsedMs >= (budgetMs ?? Infinity)
      ? { complete: false, elapsedMs }
      : { complete: true, value, elapsedMs };
  } catch (error) {
    if (error !== exhausted) throw error;
    return { complete: false, elapsedMs: performance.now() - started };
  }
}
