import type { Item } from '@latkit/network';

const PAN_STEP = 24;
export const ZOOM_IN_FACTOR = 1.25;
export const ZOOM_OUT_FACTOR = 0.8;

/** Public element commands used by canvas keyboard interaction. */
export interface InteractionCommandSink {
  panBy(dx: number, dy: number): void;
  zoomBy(factor: number): void;
  fit(animate?: boolean): void;
  select(item: Item | null): void;
}

/** Attach the stable keyboard command adapter to the focusable canvas. */
export function attachCanvasInteraction(
  canvas: HTMLCanvasElement,
  commands: InteractionCommandSink,
): void {
  const keydown = (event: KeyboardEvent) => {
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        commands.panBy(-PAN_STEP, 0);
        break;
      case 'ArrowRight':
        commands.panBy(PAN_STEP, 0);
        break;
      case 'ArrowUp':
        commands.panBy(0, -PAN_STEP);
        break;
      case 'ArrowDown':
        commands.panBy(0, PAN_STEP);
        break;
      case '+':
      case '=':
        commands.zoomBy(ZOOM_IN_FACTOR);
        break;
      case '-':
      case '_':
        commands.zoomBy(ZOOM_OUT_FACTOR);
        break;
      case 'Home':
        commands.fit(true);
        break;
      case 'Escape':
        commands.select(null);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  canvas.addEventListener('keydown', keydown);
}
