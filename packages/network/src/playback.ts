/**
 * Series-bound channels: each followed signal keeps a window of frames resident on the GPU after the
 * fixed channel slots, shared by every channel following it, and a seek moves each channel's offset
 * word to the frame it shows. The window is two halves; once the playhead passes into the later
 * one, or past the last frame as the series appends, the next frames load into the half already
 * played, so steady playback reads ahead while it plays.
 */

import type { Series } from '@latkit/model';

import type { Channel } from './channels.js';

/** What one window takes on the GPU; its CPU copy, which picking reads, takes as much again. */
const WINDOW_BYTES = 8 * 1024 * 1024;
/** What one series read may carry, time included. */
const READ_BYTES = 1024 * 1024;

/** The renderer surface a window uploads through. */
export interface PlaybackRenderer {
  /** Grow the channel buffer to hold `words` float words, keeping what it holds. */
  reserve(words: number): void;
  /** Write float words `offset` words into the channel buffer. */
  writeWords(offset: number, values: Float32Array): void;
}

/** What playback reads, and whom it tells. */
interface PlaybackDeps {
  /** Words the fixed channel slots take; windows follow them. */
  fixedWords(): number;
  /** Items in a channel's scope. */
  items(channel: Channel): number;
  /** The renderer holding the channel buffer, or null while detached. */
  renderer(): PlaybackRenderer | null;
  /** Show the frame `offset` words into the channel buffer, which picking reads as `view`. */
  moveTo(channel: Channel, offset: number, view: Float32Array): void;
  /** Keep the frame shown in the channel's own slot while its window is rewritten. */
  hold(channel: Channel): void;
  /** The series appended: its recorded range may have grown. */
  appended(channel: Channel): void;
  /** A read of the series `channel` follows failed. */
  error(channel: Channel, cause: unknown): void;
}

/** Resident frames of one signal, in two halves of a ring of slots. */
interface Window {
  /** Word offset of slot 0 in the channel buffer. */
  readonly base: number;
  readonly items: number;
  /** Slots, an even count: two halves. */
  readonly capacity: number;
  /** Frame times by slot. */
  readonly time: Float64Array;
  /** Values by slot, `items` each: the CPU copy, replayed on attach and read by picking. */
  readonly values: Float32Array;
  /** One view of `values` per slot. */
  readonly views: readonly Float32Array[];
  /** The series frame in the first resident position. */
  first: number;
  /** Frames resident, in order from `first`. */
  count: number;
  /** The slot of the first resident position. */
  start: number;
}

/** One series signal and the channels following it. */
interface Bound {
  readonly series: Series;
  readonly signal: number;
  readonly window: Window;
  /** Every channel following it; the first stands for it wherever the bound is visited once. */
  readonly channels: Channel[];
  /** The slot shown, or -1 while the channels' own slots hold what is shown. */
  shown: number;
  loading: AbortController | null;
  /** A read failed; nothing is read again until the series appends or a channel binds it anew. */
  failed: boolean;
  off: () => void;
}

/** Series-bound channels and the playhead that picks their frames. */
export interface Playback {
  /**
   * Follow one signal of a series in a channel, replacing whatever the channel followed. Following
   * the signal it already follows keeps what it shows; a signal another channel follows shares
   * that channel's frames. Either reads again after a failure.
   */
  follow(channel: Channel, series: Series, signal: number): void;
  /** Stop following in a channel. */
  stop(channel: Channel): void;
  /** Show every followed channel at `time`: each item takes its latest sample at or before it. */
  seek(time: number): void;
  /** Upload every window into a renderer that has just bound the topology. */
  upload(renderer: PlaybackRenderer): void;
  /** Stop following everywhere and forget every window: a new topology, or the controller's end. */
  reset(): void;
}

/**
 * The resident position of the latest frame at or before `time`, or -1 when it isn't resident. A
 * time before the series' first frame shows that frame.
 */
export function slotAt(w: Window, time: number, head: number): number {
  if (w.count === 0) return -1;
  if (time < w.time[w.start]!) return w.first === 0 ? 0 : -1;
  let lo = 0,
    hi = w.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (w.time[(w.start + mid) % w.capacity]! <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo < w.count || w.first + w.count === head ? lo - 1 : -1;
}

/** Create the playback for one controller's channels. */
export function createPlayback(deps: PlaybackDeps): Playback {
  /** What each series-bound channel follows; channels following one signal share it. */
  const bounds = new Map<Channel, Bound>();
  /** Windows no signal holds, by the items they fit, reused before the channel buffer grows. */
  const idle = new Map<number, Window[]>();
  /** Words the channel buffer must hold: the fixed slots and every window. */
  let words = 0;
  let playhead = -Infinity;

  function windowFor(items: number): Window {
    const reused = idle.get(items)?.pop();
    if (reused) {
      reused.first = reused.count = reused.start = 0;
      return reused;
    }
    // About 8 MiB per window, 2 to 256 slots, an even count.
    const capacity =
      2 * Math.max(1, Math.min(128, Math.floor(WINDOW_BYTES / 8 / Math.max(1, items))));
    const values = new Float32Array(capacity * items);
    const window: Window = {
      base: words,
      items,
      capacity,
      time: new Float64Array(capacity),
      values,
      views: Array.from({ length: capacity }, (_, slot) =>
        values.subarray(slot * items, (slot + 1) * items),
      ),
      first: 0,
      count: 0,
      start: 0,
    };
    words += capacity * items;
    deps.renderer()?.reserve(words);
    return window;
  }

  /** Show `bound` at the playhead, reading what it needs that isn't resident. */
  function show(bound: Bound): void {
    const w = bound.window;
    const head = bound.series.state.frameCount;
    const half = w.capacity / 2;
    const position = slotAt(w, playhead, head);
    if (position >= 0) {
      const slot = (w.start + position) % w.capacity;
      if (slot !== bound.shown) {
        bound.shown = slot;
        for (const channel of bound.channels) {
          deps.moveTo(channel, w.base + slot * w.items, w.views[slot]!);
        }
      }
      // In the later half of a full window: the next frames load into the half already played.
      if (
        position >= half &&
        w.count === w.capacity &&
        w.first + w.count < head &&
        !bound.loading
      ) {
        advance(bound);
        void read(bound, Math.min(half, head - w.first - w.count));
      }
      return;
    }
    if (bound.loading || bound.failed || head === 0) return;
    const last = w.count > 0 ? w.time[(w.start + w.count - 1) % w.capacity]! : Infinity;
    const behind = head - w.first - w.count;
    const room = w.capacity - w.count;
    if (playhead >= last && behind <= Math.max(room, half)) {
      // Past the last frame, as a live series appends: read on, into the half already played
      // when the window has no room left for what follows.
      if (behind > room) advance(bound);
      void read(bound, behind);
    } else {
      void reload(bound, head);
    }
  }

  /** Keep what `bound` shows in its channels' own slots, so its window can be rewritten. */
  function hold(bound: Bound): void {
    if (bound.shown < 0) return;
    for (const channel of bound.channels) deps.hold(channel);
    bound.shown = -1;
  }

  /** Drop the half of the window played first, holding a frame shown from it. */
  function advance(bound: Bound): void {
    const w = bound.window;
    const half = w.capacity / 2;
    if (bound.shown >= 0 && (bound.shown - w.start + w.capacity) % w.capacity < half) hold(bound);
    w.first += half;
    w.count -= half;
    w.start = (w.start + half) % w.capacity;
  }

  /** Read a window around the playhead: a quarter behind it, the rest ahead. */
  async function reload(bound: Bound, head: number): Promise<void> {
    const job = new AbortController();
    bound.loading = job;
    const w = bound.window;
    try {
      let frame = 0;
      if (Number.isFinite(playhead)) {
        const [, end] = await bound.series.locate([playhead, playhead], head, job.signal);
        job.signal.throwIfAborted();
        frame = Math.max(0, end - 1);
      }
      const first = Math.max(0, Math.min(frame - Math.floor(w.capacity / 4), head - w.capacity));
      hold(bound);
      w.first = first;
      w.count = 0;
      w.start = 0;
      await fill(bound, job.signal, Math.min(w.capacity, head - first));
    } catch (error) {
      fail(bound, job, error);
    } finally {
      settle(bound, job);
    }
  }

  /** Read `frames` more frames after those resident. */
  async function read(bound: Bound, frames: number): Promise<void> {
    const job = new AbortController();
    bound.loading = job;
    try {
      await fill(bound, job.signal, frames);
    } catch (error) {
      fail(bound, job, error);
    } finally {
      settle(bound, job);
    }
  }

  /**
   * Read `frames` frames after those resident into the slots after theirs, uploading and showing
   * each read as it lands. A sparse series leaves its unrecorded items NaN.
   */
  async function fill(bound: Bound, signal: AbortSignal, frames: number): Promise<void> {
    const { series, window: w } = bound;
    const elements = series.elementCount;
    const sparse = series.elements;
    const chunk = Math.max(1, Math.min(elements, Math.floor(READ_BYTES / 16)));
    const step = Math.max(1, Math.floor(READ_BYTES / (8 * (chunk + 1))));
    for (let done = 0; done < frames; done += step) {
      const count = Math.min(step, frames - done);
      const position = w.count;
      for (let e = 0; e === 0 || e < elements; e += chunk) {
        const columns = Math.min(chunk, elements - e);
        const block = await series.read(
          bound.signal,
          {
            frameOffset: w.first + position,
            frameCount: count,
            elementOffset: e,
            elementCount: columns,
          },
          signal,
        );
        signal.throwIfAborted();
        if (block.time.length !== count) {
          throw new RangeError('series returned an invalid sample block');
        }
        for (let f = 0; f < count; f++) {
          const slot = (w.start + position + f) % w.capacity;
          const at = slot * w.items;
          if (e === 0) {
            w.time[slot] = block.time[f]!;
            if (sparse) w.values.fill(NaN, at, at + w.items);
          }
          const row = f * block.stride;
          if (!sparse) {
            w.values.set(block.values.subarray(row, row + columns), at + e);
            continue;
          }
          for (let c = 0; c < columns; c++) {
            w.values[at + sparse[e + c]!] = block.values[row + c]!;
          }
        }
      }
      upload(w, position, count);
      w.count += count;
      show(bound);
    }
  }

  /** Upload resident positions `[position, position + count)`, split where the ring wraps. */
  function upload(w: Window, position: number, count: number): void {
    const renderer = deps.renderer();
    if (!renderer) return;
    const slot = (w.start + position) % w.capacity;
    const first = Math.min(count, w.capacity - slot);
    renderer.writeWords(
      w.base + slot * w.items,
      w.values.subarray(slot * w.items, (slot + first) * w.items),
    );
    if (first < count) {
      renderer.writeWords(w.base, w.values.subarray(0, (count - first) * w.items));
    }
  }

  function fail(bound: Bound, job: AbortController, error: unknown): void {
    if (job.signal.aborted || bound.loading !== job) return;
    bound.failed = true;
    for (const channel of bound.channels) deps.error(channel, error);
  }

  /** End a read; show again at the playhead, which may have moved on while it ran. */
  function settle(bound: Bound, job: AbortController): void {
    if (bound.loading !== job) return;
    bound.loading = null;
    if (!job.signal.aborted && !bound.failed) show(bound);
  }

  function stop(channel: Channel): void {
    const bound = bounds.get(channel);
    if (!bound) return;
    bounds.delete(channel);
    bound.channels.splice(bound.channels.indexOf(channel), 1);
    if (bound.channels.length) return;
    bound.loading?.abort();
    bound.loading = null;
    bound.off();
    const windows = idle.get(bound.window.items);
    if (windows) windows.push(bound.window);
    else idle.set(bound.window.items, [bound.window]);
  }

  /** A channel joins `bound`, shown what it shows, and a failed read is tried again. */
  function join(channel: Channel, bound: Bound): void {
    if (bounds.get(channel) !== bound) {
      stop(channel);
      bounds.set(channel, bound);
      bound.channels.push(channel);
      const w = bound.window;
      if (bound.shown >= 0) {
        deps.moveTo(channel, w.base + bound.shown * w.items, w.views[bound.shown]!);
      }
    }
    bound.failed = false;
    show(bound);
  }

  return {
    follow(channel, series, signal) {
      const items = deps.items(channel);
      for (const bound of bounds.values()) {
        if (bound.series === series && bound.signal === signal && bound.window.items === items) {
          join(channel, bound);
          return;
        }
      }
      stop(channel);
      const bound: Bound = {
        series,
        signal,
        window: windowFor(items),
        channels: [channel],
        shown: -1,
        loading: null,
        failed: false,
        off: () => {},
      };
      bound.off = series.on('append', () => {
        if (!bound.channels.length) return;
        bound.failed = false;
        for (const shown of bound.channels) deps.appended(shown);
        show(bound);
      });
      bounds.set(channel, bound);
      show(bound);
    },

    stop,

    seek(time) {
      playhead = time;
      for (const [channel, bound] of bounds) if (bound.channels[0] === channel) show(bound);
    },

    upload(renderer) {
      renderer.reserve(words);
      for (const [channel, bound] of bounds) {
        if (bound.channels[0] === channel) {
          renderer.writeWords(bound.window.base, bound.window.values);
        }
      }
    },

    reset() {
      for (const channel of [...bounds.keys()]) stop(channel);
      idle.clear();
      words = deps.fixedWords();
    },
  };
}
