import { colormapCss, type ColormapName } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** A colormap ramp with its label, over the main view. */
export class Legend {
  readonly #ramp = h('span', { class: 'ramp', 'aria-hidden': 'true' });
  readonly #label = h('span');

  constructor(stage: Stage) {
    stage.regions.main.append(h('p', { class: 'legend' }, this.#ramp, this.#label));
  }

  ramp(colormap: ColormapName, label: string): void {
    this.#ramp.style.background = colormapCss(colormap);
    this.#label.textContent = label;
  }
}
