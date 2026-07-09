import type { Viewport } from '../camera/projection.js';

/**
 * Canvas factory + size readers + cleanup.
 *
 * The resize-to-render path lives in `RenderLoop` (see `attachResize` there).
 * Co-locating that wiring with the loop is the only way to guarantee the
 * correct scheduler is used: the buffer/display contract, "the canvas
 * backing buffer matches its CSS-displayed size at paint time", is the
 * render loop's responsibility, so the render loop owns the timing.
 */
export interface Surface {
  /** Canvas element that fills the supplied container. */
  readonly element: HTMLCanvasElement;
  /** CSS-pixel viewport. Reads layout fresh; cheap when DOM is clean. */
  size(): Viewport;
  /** Canvas DOMRect for clientX/Y to canvas-local conversion. Reads fresh. */
  rect(): DOMRect;
  /** Remove DOM listeners and detach the canvas from its container. */
  destroy(): void;
}

/** Create the interaction canvas inside a container and return its readers. */
export function createSurface(container: HTMLElement): Surface {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';

  const suppressContextMenu = (e: Event): void => {
    e.preventDefault();
  };
  canvas.addEventListener('contextmenu', suppressContextMenu);
  container.appendChild(canvas);

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
      canvas.removeEventListener('contextmenu', suppressContextMenu);
      canvas.remove();
    },
  };
}
