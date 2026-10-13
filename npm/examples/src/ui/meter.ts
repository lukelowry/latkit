import type { View } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** A readout over a view: frames per second, the view's frame time, and the page's own measures. */
export class Meter {
  readonly #line = h('p', { class: 'meter', 'aria-live': 'off' });
  readonly #times = new Map<string, number>();
  readonly #notes: (() => string)[] = [];
  #frames = 0;
  #since = performance.now();

  constructor(stage: Stage, view: View) {
    stage.regions.main.append(this.#line);
    stage.frame(() => {
      this.#frames++;
      const now = performance.now();
      if (now - this.#since < 500) return;
      const parts = [`${((this.#frames * 1000) / (now - this.#since)).toFixed(0)} fps`, `frame ${view.stats.cpuMs.toFixed(1)} ms`];
      for (const [label, ms] of this.#times) parts.push(`${label} ${ms.toFixed(1)} ms`);
      this.#line.textContent = [...parts, ...this.#notes.map((note) => note())].join('  ·  ');
      this.#frames = 0;
      this.#since = now;
    });
  }

  /** Runs `work`, keeping a moving average of its time under `label`. */
  measure<T>(label: string, work: () => T): T {
    const start = performance.now();
    const result = work();
    const ms = performance.now() - start;
    this.#times.set(label, (this.#times.get(label) ?? ms) * 0.9 + ms * 0.1);
    return result;
  }

  /** A readout computed at each refresh. */
  note(read: () => string): void {
    this.#notes.push(read);
  }
}
