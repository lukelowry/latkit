import { colormapCss, type Colormap } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** A colormap ramp and label over the main view. It sits at the bottom, or at the top (`'top'`) so
 * it does not cover a plot's axes. */
export class Legend {
  readonly #ramp = h('span', { class: 'ramp', 'aria-hidden': 'true' });
  readonly #label = h('span');
  readonly #element = h('p', { class: 'legend' }, this.#ramp, this.#label);

  constructor(stage: Stage, place: 'foot' | 'top' = 'foot') {
    this.#element.classList.toggle('top', place === 'top');
    stage.regions.main.append(this.#element);
  }

  ramp(colormap: Colormap, label: string): void {
    this.#ramp.style.background = colormapCss(colormap);
    this.#label.textContent = label;
  }

  /** Hides the legend, for example while nothing it describes is shown. */
  set hidden(hidden: boolean) {
    this.#element.hidden = hidden;
  }
}
