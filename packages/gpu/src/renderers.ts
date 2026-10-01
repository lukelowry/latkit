import type { Renderer } from './render.js';
import { GpuError } from './error.js';
export const children = new WeakMap<Renderer, readonly Renderer[]>();
/** Lock every composed child as well as its parent; hidden concurrent use is still a conflict. */
export function renderers(roots: readonly Renderer[]): Renderer[] {
  const found = new Set<Renderer>(),
    pending = [...roots];
  while (pending.length) {
    const renderer = pending.pop()!;
    if (found.has(renderer))
      throw new GpuError('invalid-input', 'A renderer appears more than once in the composition');
    found.add(renderer);
    pending.push(...(children.get(renderer) ?? []));
  }
  return [...found];
}
