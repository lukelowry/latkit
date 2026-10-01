import type { Viewport } from '../camera.js';

/** Interaction and geometry helpers for a caller-owned canvas. */
export interface Surface {
  /** Caller-owned canvas used for presentation and input. */
  readonly element: HTMLCanvasElement;
  /** CSS-pixel viewport. Reads layout fresh; cheap when the DOM is clean. */
  size(): Viewport;
  /** Canvas DOMRect for clientX/Y to canvas-local conversion. Reads fresh. */
  rect(): DOMRect;
  /** Claim touch gestures for the diagram, or hand them back to the page. */
  setNavigable(on: boolean): void;
  /** Restore the interaction styles the surface changed. */
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
    setNavigable(on) {
      canvas.style.touchAction = on ? 'none' : originalStyle.touchAction;
    },
    destroy() {
      canvas.style.touchAction = originalStyle.touchAction;
      canvas.style.userSelect = originalStyle.userSelect;
    },
  };
}
