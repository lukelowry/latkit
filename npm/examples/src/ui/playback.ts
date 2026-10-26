import { h } from './dom.js';
import type { Stage } from './stage.js';

export interface PlaybackOptions {
  /** Shows coordinate `at` in every view. */
  show(at: number): void;
  /** Whether the data is recorded while it plays (default true). Live playback follows the end of
   * the data. Otherwise playing loops. */
  live?: boolean;
  /** Seconds of data shown per second of playback (default 1). */
  rate?: number;
  /** Instant replay: how many seconds back from the end to start, and the playback rate. */
  replay?: { seconds: number; rate: number };
  /** Called when playback goes live or stops being live. */
  change?(live: boolean): void;
  /** Formats coordinate `at` for the transport. Defaults to seconds. */
  format?(at: number): string;
}

/** Playback state (live, paused, or playing a recorded span) and the transport controls that drive
 * it. */
export class Playback {
  mode: 'live' | 'playing' | 'paused';
  start = 0;
  end = 0;
  #at = 0;
  #rate: number;
  #live: boolean;
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

  /** Hides the transport, for example while there is nothing to play. */
  set hidden(hidden: boolean) {
    this.#transport.hidden = hidden;
    this.#slider.hidden = hidden;
  }

  /** Sets the seconds of data shown per second of playback, from now on. */
  set rate(rate: number) {
    this.options.rate = rate;
    if (this.mode === 'playing') this.#rate = rate;
  }

  /** Sets whether the data is recorded while it plays. Going live follows the end of the data.
   * Otherwise playback pauses, and playing then loops. */
  set live(live: boolean) {
    this.#live = live;
    this.#set(live ? 'live' : 'paused');
  }

  /** Pauses and shows coordinate `at`. */
  seek(at: number): void {
    this.#set('paused');
    this.#show(at);
  }

  /** Updates the recorded span. Live playback jumps to its end, and a position before its start
   * moves to the start. */
  record([start, end]: readonly [number, number]): void {
    this.start = start;
    this.end = end;
    this.#slider.min = String(start);
    this.#slider.max = String(Math.max(end, start + 1e-3));
    if (this.mode === 'live') this.#show(end);
    else if (this.#at < start) this.#show(start);
  }

  /** Goes live, or, for recorded data, plays on from the current position. */
  play(): void {
    this.#rate = this.options.rate ?? 1;
    this.#set(this.#live ? 'live' : 'playing');
    if (this.#live) this.#show(this.end);
  }

  pause(): void {
    this.#set('paused');
  }

  /** Plays the last `replay.seconds` again at `replay.rate`, then goes live if the data is live. */
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
    this.#time.value = this.options.format?.(at) ?? `${at.toFixed(2)} s`;
    this.options.show(at);
  }
}
