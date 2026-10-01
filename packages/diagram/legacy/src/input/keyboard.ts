/**
 * The keyboard map: arrows, plus and minus, Home, Tab, Enter, Escape, Delete, and Space, each
 * claimed only when the controller uses it. Keys with Ctrl, Meta, or Alt belong to the host.
 */

/** One key gesture. */
export type KeyIntent =
  /** An arrow key: a unit screen direction; Shift makes it large. */
  | { kind: 'arrow'; dx: number; dy: number; large: boolean }
  /** Plus or minus: zoom about the viewport center. */
  | { kind: 'zoom'; factor: number }
  /** Home: fit. */
  | { kind: 'fit' }
  /** Tab or Shift+Tab: the next or previous block. */
  | { kind: 'tab'; back: boolean }
  /** Enter: open the selection. */
  | { kind: 'open' }
  /** Escape: cancel a drag, else clear the selection. */
  | { kind: 'escape' }
  /** Delete or Backspace: propose deleting the selection. */
  | { kind: 'delete' }
  /** Space pressed or released: held, a mouse drag pans. */
  | { kind: 'space'; down: boolean };

/** Multiplicative zoom per plus or minus press. */
const ZOOM_STEP = 1.2;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The intent one key press carries, or null for a key the map does not know. */
function intentFor(event: KeyboardEvent): KeyIntent | null {
  const arrow = ARROWS[event.key];
  if (arrow) return { kind: 'arrow', dx: arrow[0], dy: arrow[1], large: event.shiftKey };
  switch (event.key) {
    case '+':
    case '=':
      return { kind: 'zoom', factor: ZOOM_STEP };
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1 / ZOOM_STEP };
    case 'Home':
      return { kind: 'fit' };
    case 'Tab':
      return { kind: 'tab', back: event.shiftKey };
    case 'Enter':
      return { kind: 'open' };
    case 'Escape':
      return { kind: 'escape' };
    case 'Delete':
    case 'Backspace':
      return { kind: 'delete' };
    default:
      return null;
  }
}

/** Whether a key belongs to the host or an input method rather than the map. */
function foreign(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || event.isComposing;
}

/**
 * Attach the keyboard map to a canvas, making it focusable when it has no tabindex (restored on
 * destroy). `emit` returns whether the controller used the key; only then is its default
 * prevented, so Tab leaves the canvas at the ends.
 *
 * @remarks
 * Space emits once when pressed (auto-repeats are claimed as the press was, not re-emitted) and
 * once when released. Losing focus while it is held releases it, and so does `destroy`: once the
 * listeners are gone no keyup can arrive, and a Space the controller still counted as held would
 * turn every later drag into a pan.
 */
export function attachKeyboard(
  canvas: HTMLCanvasElement,
  emit: (intent: KeyIntent) => boolean,
): { destroy(): void } {
  const madeFocusable = !canvas.hasAttribute('tabindex');
  if (madeFocusable) canvas.tabIndex = 0;
  /** Space is held and the controller claimed its press. */
  let spaceHeld = false;

  const releaseSpace = (): void => {
    if (!spaceHeld) return;
    spaceHeld = false;
    emit({ kind: 'space', down: false });
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === ' ') {
      if (foreign(event)) return;
      if (spaceHeld) {
        // Holding Space auto-repeats; keep the page from scrolling without re-emitting.
        event.preventDefault();
        return;
      }
      if (event.repeat) return;
      if (emit({ kind: 'space', down: true })) {
        spaceHeld = true;
        event.preventDefault();
      }
      return;
    }
    if (foreign(event)) return;
    const intent = intentFor(event);
    if (intent && emit(intent)) event.preventDefault();
  };

  const onKeyup = (event: KeyboardEvent): void => {
    if (event.key !== ' ' || !spaceHeld) return;
    event.preventDefault();
    releaseSpace();
  };

  canvas.addEventListener('keydown', onKeydown);
  canvas.addEventListener('keyup', onKeyup);
  canvas.addEventListener('blur', releaseSpace);

  return {
    /** Stop listening, release a held Space, and remove the tabindex the map added. */
    destroy() {
      canvas.removeEventListener('keydown', onKeydown);
      canvas.removeEventListener('keyup', onKeyup);
      canvas.removeEventListener('blur', releaseSpace);
      if (madeFocusable) canvas.removeAttribute('tabindex');
      releaseSpace();
    },
  };
}
