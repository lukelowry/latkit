import type { View } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** A menu item. A disabled item is shown but cannot be chosen. */
export interface Item {
  label: string;
  run: () => void;
  disabled?: boolean;
}

/** A context menu shown over the main view where a view requested one. It closes when an item runs,
 * on Escape, or on a press outside it. */
export class Menu {
  readonly #element = h('div', { class: 'menu', role: 'menu', hidden: true });

  constructor(private readonly stage: Stage) {
    const { signal } = stage;
    stage.regions.main.append(this.#element);
    addEventListener(
      'pointerdown',
      (event) => {
        if (!this.#element.contains(event.target as Node)) this.close();
      },
      { signal, capture: true },
    );
    addEventListener('keydown', (event) => event.key === 'Escape' && this.close(), { signal });
  }

  /** Opens `items` at `point`, in CSS pixels from the top left of `view`, kept at least 8 px inside
   * the main view. */
  open(view: View, point: [number, number], items: readonly Item[]): void {
    const canvas = this.stage.canvases.find((c) => c.layout.some((p) => p.view === view));
    const panel = canvas?.layout.find((p) => p.view === view)?.at ?? [0, 0, 1, 1];
    const element = canvas?.element;
    if (!(element instanceof HTMLCanvasElement)) return;
    this.#element.replaceChildren(
      ...items.map(({ label, run, disabled }) => {
        const button = h('button', { type: 'button', role: 'menuitem', disabled }, label);
        button.addEventListener('click', () => {
          this.close();
          run();
        });
        return button;
      }),
    );
    this.#element.hidden = false;
    const main = this.stage.regions.main;
    const [width, height] = [this.#element.offsetWidth, this.#element.offsetHeight];
    const x = element.offsetLeft + panel[0] * element.clientWidth + point[0];
    const y = element.offsetTop + panel[1] * element.clientHeight + point[1];
    const left = Math.min(x, main.clientWidth - width - 8);
    const top = Math.min(y, main.clientHeight - height - 8);
    this.#element.style.left = `${Math.max(8, left)}px`;
    this.#element.style.top = `${Math.max(8, top)}px`;
    this.#element.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }

  close(): void {
    this.#element.hidden = true;
  }
}
