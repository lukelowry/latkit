import type { Point } from '@latkit/gpu';
import type { Network } from './network.js';
/** What a network's own gestures drive; the view implements it. */
export interface Gestures {
  locate(item: Network.Item): Point | null;
  neighborhood(item: Network.Item): readonly Network.Item[];
  reveal(item: Network.Item): void;
  selection(): readonly Network.Item[];
  /** Select as the user did, reporting it. */
  choose(items: readonly Network.Item[]): void;
}

/** An arrow steps from the selection to its neighbor in that direction, and reveals it. */
export function step(event: KeyboardEvent, view: Gestures): boolean {
  const key = event.key;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown')
    return false;
  const dx = key === 'ArrowLeft' ? 1 : key === 'ArrowRight' ? -1 : 0,
    dy = key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? -1 : 0;
  const selected = view.selection().at(-1),
    origin = selected && view.locate(selected);
  if (!selected || !origin) return true;
  let best: Network.Item | undefined,
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
  return true;
}
