/**
 * The keyboard map every host otherwise rewrites: arrows pan, Shift with arrows rotates, plus and
 * minus zoom, Home fits, Escape clears the selection. Without navigation the arrows step the
 * selection along the topology instead and only Escape remains. Attached beside the pointer
 * adapter so one canvas carries one input vocabulary.
 */

/** Normalized keyboard gesture emitted by the DOM keyboard adapter. */
export type KeyIntent =
  /** Drag the content by CSS pixels, revealing what lies in the arrow's direction. */
  | { kind: 'pan'; dx: number; dy: number }
  /** Turn the bearing and tilt the pitch by rotation-gesture pixels. */
  | { kind: 'rotate'; dx: number; dy: number }
  /** Zoom around the viewport center by a multiplicative factor. */
  | { kind: 'zoom'; factor: number }
  /** Fit the loaded topology. */
  | { kind: 'fit' }
  /** Walk the selection along the topology in a unit screen direction. */
  | { kind: 'step'; dx: number; dy: number }
  /** Clear the selection. */
  | { kind: 'clear' };

/** CSS pixels one arrow press pans or rotates by. */
const STEP_PX = 48;
/** Multiplicative zoom per plus or minus press. */
const ZOOM_STEP = 1.2;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The intent one key press carries, or null for a key the map does not claim. */
function intentFor(event: KeyboardEvent, navigable: boolean): KeyIntent | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const arrow = ARROWS[event.key];
  if (arrow) {
    if (!navigable) return event.shiftKey ? null : { kind: 'step', dx: arrow[0], dy: arrow[1] };
    const dx = arrow[0] * STEP_PX;
    const dy = arrow[1] * STEP_PX;
    // An arrow reveals what lies in its direction: the content drags the other way.
    return event.shiftKey ? { kind: 'rotate', dx, dy } : { kind: 'pan', dx: 0 - dx, dy: 0 - dy };
  }
  if (event.key === 'Escape') return { kind: 'clear' };
  if (!navigable) return null;
  switch (event.key) {
    case '+':
    case '=':
      return { kind: 'zoom', factor: ZOOM_STEP };
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1 / ZOOM_STEP };
    case 'Home':
      return { kind: 'fit' };
    default:
      return null;
  }
}

/**
 * Attach the keyboard map to a canvas, making it focusable when the host has not.
 *
 * `navigable` is read per key press, so the map follows the live interaction option. The
 * returned disposer removes the listener and restores the canvas's focusability.
 */
export function attachKeyboard(
  canvas: HTMLCanvasElement,
  emit: (intent: KeyIntent) => void,
  navigable: () => boolean = () => true,
): { destroy(): void } {
  const madeFocusable = !canvas.hasAttribute('tabindex');
  if (madeFocusable) canvas.tabIndex = 0;

  const onKeydown = (event: KeyboardEvent): void => {
    const intent = intentFor(event, navigable());
    if (!intent) return;
    event.preventDefault();
    emit(intent);
  };
  canvas.addEventListener('keydown', onKeydown);

  return {
    destroy() {
      canvas.removeEventListener('keydown', onKeydown);
      if (madeFocusable) canvas.removeAttribute('tabindex');
    },
  };
}
