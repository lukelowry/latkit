import type { Viewport } from '../camera/projection.js';

/**
 * Interaction and geometry helpers for a caller-owned canvas.
 *
 * The resize-to-render path lives in `RenderLoop`.
 * Co-locating that wiring with the loop is the only way to guarantee the
 * correct scheduler is used: the buffer/display contract, "the canvas
 * backing buffer matches its CSS-displayed size at paint time", is the
 * render loop's responsibility, so the render loop owns the timing.
 */
export interface Surface {
  /** Caller-owned canvas used for presentation and input. */
  readonly element: HTMLCanvasElement;
  /** CSS-pixel viewport. Reads layout fresh; cheap when DOM is clean. */
  size(): Viewport;
  /** Canvas DOMRect for clientX/Y to canvas-local conversion. Reads fresh. */
  rect(): DOMRect;
  /** Remove DOM listeners and restore Latkit-managed interaction styles. */
  destroy(): void;
}

/** Configure a caller-owned interaction canvas and return its readers. */
export function createSurface(canvas: HTMLCanvasElement): Surface {
  const originalStyle = {
    touchAction: canvas.style.touchAction,
    userSelect: canvas.style.userSelect,
  };

  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';

  /** Read the current CSS layout box for size and input coordinate mapping. */
  function readRect(): DOMRect {
    return canvas.getBoundingClientRect();
  }

  return {
    element: canvas,
    size() {
      const r = readRect();
      return { w: r.width, h: r.height };
    },
    rect: readRect,
    destroy() {
      canvas.style.touchAction = originalStyle.touchAction;
      canvas.style.userSelect = originalStyle.userSelect;
    },
  };
}
