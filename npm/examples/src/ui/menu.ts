import type { View } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** An item of a menu: what it says, and what it does; a disabled one shows but does nothing. */
export interface Item {
  label: string;
  run: () => void;
  disabled?: boolean;
}

/** A menu over the main view where a view asked for one; gone once an item runs, on Escape, or on a
 * press elsewhere. */
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

  /** Opens `items` at `point`, CSS pixels over `view`, kept inside the main view. */
  open(view: View, point: [number, number], items: readonly Item[]): void {
    const shown = this.stage.shown.find((s) => s.view === view);
    if (!shown) return;
    const { element: canvas, panel } = shown;
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
    const x = canvas.offsetLeft + panel[0] * canvas.clientWidth + point[0];
    const y = canvas.offsetTop + panel[1] * canvas.clientHeight + point[1];
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
