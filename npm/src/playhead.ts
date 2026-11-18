/** Playheads, which move the axis coordinate that the views following them show. */

import type * as bindings from '../pkg/latkit.js';
import { Handle, inner, wasm } from './internal.js';

/**
 * A playhead views follow: the axis coordinate they show, such as a time, which moves on its own
 * while it plays. Views that follow it show the same coordinate in the same frame, and the page
 * runs nothing per frame to move them. Scrubbing a view that follows it moves it, and every other
 * view that follows it.
 *
 * ```ts
 * const playhead = new Playhead({ span: [0, duration] });
 * monitor.playhead = map.playhead = playhead;
 * playhead.on('at', (at) => (scrubber.value = String(at)));
 * playhead.play(); // one axis unit per second
 * ```
 */
export class Playhead extends Handle {
  /** A paused playhead, which plays forward at one axis unit per second once it plays. */
  constructor(
    options: {
      /** The axis coordinate it starts at. Defaults to 0. */
      at?: number;
      /** The coordinates it stays between. Defaults to none. */
      span?: readonly [number, number] | null;
      /** Whether it wraps to the other end of its span instead of stopping. Defaults to false. */
      loop?: boolean;
    } = {},
  ) {
    super(new (wasm().Playhead)(options.at ?? 0), 'Playhead');
    if (options.span) this.span = options.span;
    if (options.loop) this.loop = true;
  }

  /**
   * The axis coordinate it is at. Setting it moves every view that follows it at once, and stops a
   * live playhead.
   */
  get at(): number {
    return playhead(this).at;
  }

  set at(at: number) {
    playhead(this).seek(at);
  }

  /**
   * Axis units per second it moves while it plays, backward when negative. While live, the rate the
   * end of its span moves.
   */
  get rate(): number {
    return playhead(this).rate;
  }

  /** Whether it is moving. A live playhead that reached the end of its span waits there. */
  get playing(): boolean {
    return playhead(this).playing;
  }

  /**
   * Plays at `rate` axis units per second from the next frame, backward when negative. At the end of
   * its span it stops, or wraps to the other end when it loops. A frame moves it at most a quarter
   * second's worth, so a page that stalls or is hidden resumes where it was.
   */
  play(rate = 1): void {
    playhead(this).play(rate);
  }

  /** Stops it where it is, live or not. */
  pause(): void {
    playhead(this).pause();
  }

  /**
   * Whether it plays along the end of its span while the page extends the span as data arrives, as
   * a recording does. It trails the end by a little more than the time between arrivals, at the rate
   * the end moves, so data that arrives in uneven chunks plays at an even pace, and eases to a stop
   * at the end when no more arrives. Turning it on starts at the end. Seeking, playing, or pausing
   * stops it, and turning it off pauses it where it is.
   *
   * ```ts
   * playhead.live = true;
   * // As frames arrive:
   * data.append('Bus', times, { vm });
   * playhead.span = [0, times.at(-1)];
   * ```
   */
  get live(): boolean {
    return playhead(this).live;
  }

  set live(live: boolean) {
    playhead(this).live = live;
  }

  /** The coordinates it stays between, lowest first, or `null` to move anywhere. */
  get span(): readonly [number, number] | null {
    const span = playhead(this).span;
    return span ? [span[0]!, span[1]!] : null;
  }

  set span(span: readonly [number, number] | null) {
    playhead(this).span = span ? Float64Array.from(span) : undefined;
  }

  /** Whether it wraps to the other end of its span instead of stopping. */
  get loop(): boolean {
    return playhead(this).looping;
  }

  set loop(loop: boolean) {
    playhead(this).looping = loop;
  }

  /**
   * Calls `listener` with the coordinate whenever it moves: at most once per frame while it plays,
   * and whenever it is set or scrubbed. Returns a function that stops it.
   */
  on(type: 'at', listener: (at: number) => void): () => void {
    const listening = playhead(this).on((at: number) => listener(at));
    return () => listening.free();
  }
}

/** @internal Returns the bindings playhead of `owner`. */
export function playhead(owner: Playhead): bindings.Playhead {
  return inner<bindings.Playhead>(owner);
}
