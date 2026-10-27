/**
 * A page's timeline: the recorded span of a dataset with an axis, played live, paused, or
 * replayed, with its transport under the canvas. Live, it follows the end of the data and forgets
 * frames older than the span it keeps.
 */
import type { Data } from 'latkit';
import { h } from './dom.js';
import type { Timeline as Shown } from './page.js';

export interface TimelineOptions {
  data: Data;
  keep?: number;
  replay?: { seconds: number; rate: number };
  show?(at: number): void;
  change?(live: boolean): void;
}

export class Timeline implements Shown {
  mode: 'live' | 'playing' | 'paused' = 'live';
  #at = 0;
  #span: readonly [number, number] = [0, 0];
  #rate = 1;
  readonly #toggle = h('button', { type: 'button', class: 'primary' });
  readonly #slider = h('input', {
    type: 'range',
    step: 'any',
    min: 0,
    max: 1,
    'aria-label': 'Time',
  });
  readonly #time = h('output', {}, '0.00 s');

  constructor(
    private readonly options: TimelineOptions,
    footer: HTMLElement,
    key: (key: string, run: () => void) => void,
    /** Moves every view of the page to coordinate `at`. */
    private readonly move: (at: number) => void,
    signal: AbortSignal,
  ) {
    const transport = h('div', { class: 'transport' }, this.#toggle);
    const flip = () => (this.mode === 'paused' ? this.play() : this.#set('paused'));
    this.#toggle.addEventListener('click', flip, { signal });
    key('k', flip);
    this.#slider.addEventListener('input', () => this.#seek(this.#slider.valueAsNumber), {
      signal,
    });
    if (options.replay) {
      const replay = h('button', { type: 'button' }, 'Replay', h('kbd', {}, 'R'));
      replay.addEventListener('click', () => this.replay(), { signal });
      key('r', () => this.replay());
      transport.append(replay);
    }
    transport.append(this.#time);
    footer.append(transport, this.#slider);
    document.addEventListener('visibilitychange', () => document.hidden && this.#set('paused'), {
      signal,
    });
    this.#label();
  }

  get at(): number {
    return this.#at;
  }

  /** Goes live: shows the end of the data as it records. */
  play(): void {
    this.#rate = 1;
    this.#set('live');
    this.#show(this.#span[1]);
  }

  /** Plays the last `replay.seconds` at `replay.rate`, then goes live. */
  replay(): void {
    const { replay } = this.options;
    if (!replay) return;
    this.#rate = replay.rate;
    this.#set('playing');
    this.#show(Math.max(this.#span[0], this.#span[1] - replay.seconds));
  }

  /** Advances by `dt` seconds of display time. Live, it takes the data's newest span. */
  tick(dt: number): void {
    if (this.mode === 'live') {
      const span = this.options.data.describe().span;
      if (!span || span[1] === this.#span[1]) return;
      const { keep } = this.options;
      if (keep !== undefined && span[1] - span[0] > keep) this.options.data.forget(span[1] - keep);
      this.#extent([Math.max(span[0], span[1] - (keep ?? Infinity)), span[1]]);
      this.#show(span[1]);
    } else if (this.mode === 'playing') {
      const next = this.#at + dt * this.#rate;
      if (next < this.#span[1]) this.#show(next);
      else this.play();
    }
  }

  #extent(span: readonly [number, number]): void {
    this.#span = span;
    this.#slider.min = String(span[0]);
    this.#slider.max = String(Math.max(span[1], span[0] + 1e-3));
  }

  #seek(at: number): void {
    this.#set('paused');
    this.#show(at);
  }

  #set(mode: Timeline['mode']): void {
    const was = this.mode === 'live';
    this.mode = mode;
    this.#label();
    if (was !== (mode === 'live')) this.options.change?.(mode === 'live');
  }

  #label(): void {
    this.#toggle.textContent = this.mode === 'paused' ? 'Live' : 'Pause';
    this.#toggle.append(h('kbd', {}, 'K'));
  }

  #show(at: number): void {
    this.#at = at;
    this.#slider.value = String(at);
    this.#time.value = `${at.toFixed(2)} s`;
    this.move(at);
    this.options.show?.(at);
  }
}
