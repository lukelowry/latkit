import { h } from './dom.js';
import type { Stage } from './stage.js';

export interface PlaybackOptions {
  /** Shows coordinate `at` in every view. */
  show(at: number): void;
  /** Whether the data records as it plays: live follows its end. Otherwise playing loops. */
  live?: boolean;
  /** Seconds of data a second of playing shows. */
  rate?: number;
  /** Instant replay: how many seconds back from the end, and at what rate. */
  replay?: { seconds: number; rate: number };
  /** Called as playback goes live or leaves it. */
  change?(live: boolean): void;
}

/** Live, paused, or playing a recorded span, with the transport that drives it. */
export class Playback {
  mode: 'live' | 'playing' | 'paused';
  start = 0;
  end = 0;
  #at = 0;
  #rate: number;
  readonly #live: boolean;
  readonly #toggle = h('button', { type: 'button', class: 'primary' });
  readonly #slider = h('input', {
    type: 'range',
    step: 'any',
    min: 0,
    max: 1,
    value: 0,
    'aria-label': 'Time',
  });
  readonly #time = h('output', {}, '0.00 s');
  readonly #transport = h('div', { class: 'transport' }, this.#toggle);

  constructor(
    stage: Stage,
    private readonly options: PlaybackOptions,
  ) {
    const { signal } = stage;
    this.#live = options.live ?? true;
    this.#rate = options.rate ?? 1;
    this.mode = this.#live ? 'live' : 'playing';
    const flip = () => (this.mode === 'paused' ? this.play() : this.pause());
    this.#toggle.addEventListener('click', flip, { signal });
    this.#slider.addEventListener(
      'input',
      () => {
        this.#set('paused');
        this.#show(this.#slider.valueAsNumber);
      },
      { signal },
    );
    stage.key('k', flip);
    if (options.replay) {
      const replay = h('button', { type: 'button' }, 'Replay', h('kbd', {}, 'R'));
      replay.addEventListener('click', () => this.replay(), { signal });
      stage.key('r', () => this.replay());
      this.#transport.append(replay);
    }
    this.#transport.append(this.#time);
    stage.regions.timeline.append(this.#transport, this.#slider);
    stage.frame((dt) => {
      if (this.mode !== 'playing') return;
      const next = this.#at + dt * this.#rate;
      if (next < this.end) this.#show(next);
      else if (this.#live) this.play();
      else this.#show(this.start + ((next - this.start) % Math.max(this.end - this.start, 1e-9)));
    });
    document.addEventListener('visibilitychange', () => document.hidden && this.pause(), {
      signal,
    });
    this.#label();
  }

  get at(): number {
    return this.#at;
  }

  /** Hides the transport, as while there is nothing to play. */
  set hidden(hidden: boolean) {
    this.#transport.hidden = hidden;
    this.#slider.hidden = hidden;
  }

  /** Seconds of data a second of playing shows, from now on. */
  set rate(rate: number) {
    this.options.rate = rate;
    if (this.mode === 'playing') this.#rate = rate;
  }

  /** The recorded span changed; live playback shows its end. */
  record([start, end]: readonly [number, number]): void {
    this.start = start;
    this.end = end;
    this.#slider.min = String(start);
    this.#slider.max = String(Math.max(end, start + 1e-3));
    if (this.mode === 'live') this.#show(end);
    else if (this.#at < start) this.#show(start);
  }

  /** Goes live, or for recorded data plays on from where it is. */
  play(): void {
    this.#rate = this.options.rate ?? 1;
    this.#set(this.#live ? 'live' : 'playing');
    if (this.#live) this.#show(this.end);
  }

  pause(): void {
    this.#set('paused');
  }

  /** Plays the last seconds again, slowly, then goes live. */
  replay(): void {
    const replay = this.options.replay;
    if (!replay) return;
    this.#rate = replay.rate;
    this.#set('playing');
    this.#show(Math.max(this.start, this.end - replay.seconds));
  }

  #set(mode: Playback['mode']): void {
    const was = this.mode === 'live';
    this.mode = mode;
    this.#label();
    if (was !== (mode === 'live')) this.options.change?.(mode === 'live');
  }

  #label(): void {
    this.#toggle.textContent = this.mode !== 'paused' ? 'Pause' : this.#live ? 'Live' : 'Play';
    this.#toggle.append(h('kbd', {}, 'K'));
  }

  #show(at: number): void {
    this.#at = at;
    this.#slider.value = String(at);
    this.#time.value = `${at.toFixed(2)} s`;
    this.options.show(at);
  }
}
