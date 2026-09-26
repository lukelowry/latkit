/**
 * Series-bound channels: each keeps a window of frames resident on the GPU after the fixed channel
 * slots, and a seek moves the channel's offset word to the frame it shows. The window is two
 * halves; once the playhead passes into the later one, the next frames load into the half already
 * played, so steady playback reads ahead while it plays.
 */

import type { Series } from '@latkit/model';

import type { Channel } from './channels.js';

/** What one channel's window may take on the GPU. */
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
  /** A series read failed. */
  error(error: Error): void;
}

/** Resident frames of one channel, in two halves of a ring of slots. */
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
  /** The slot of the first resident position: 0 or half the capacity. */
  start: number;
}

/** One channel following one series signal. */
interface Bound {
  readonly channel: Channel;
  readonly series: Series;
  readonly signal: number;
  readonly window: Window;
  /** The slot shown, or -1 while the channel's own slot holds what is shown. */
  shown: number;
  loading: AbortController | null;
  /** A read failed; nothing is read again until the series appends or the channel is bound anew. */
  failed: boolean;
  off: () => void;
}

/** Series-bound channels and the playhead that picks their frames. */
export interface Playback {
  /** Follow one signal of a series in a channel, replacing whatever the channel followed. */
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
  const bounds = new Map<Channel, Bound>();
  /** Every window allocated since the topology loaded; a channel keeps its region when it stops. */
  const windows = new Map<Channel, Window>();
  /** Words the channel buffer must hold: the fixed slots and every window. */
  let words = 0;
  let playhead = -Infinity;

  function windowFor(channel: Channel): Window {
    const known = windows.get(channel);
    if (known) return known;
    const items = deps.items(channel);
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
    windows.set(channel, window);
    deps.renderer()?.reserve(words);
    return window;
  }

  /** Show `bound` at the playhead, reading what it needs that isn't resident. */
  function show(bound: Bound): void {
    const w = bound.window;
    const head = bound.series.state.frameCount;
    const position = slotAt(w, playhead, head);
    if (position >= 0) {
      const slot = (w.start + position) % w.capacity;
      if (slot !== bound.shown) {
        bound.shown = slot;
        deps.moveTo(bound.channel, w.base + slot * w.items, w.views[slot]!);
      }
      // In the later half of a full window: the next frames load into the half already played.
      const half = w.capacity / 2;
      if (
        position >= half &&
        w.count === w.capacity &&
        w.first + w.count < head &&
        !bound.loading
      ) {
        w.first += half;
        w.count -= half;
        w.start = (w.start + half) % w.capacity;
        void read(bound, Math.min(half, head - w.first - w.count));
      }
      return;
    }
    if (bound.loading || bound.failed || head === 0) return;
    const last = w.count > 0 ? w.time[(w.start + w.count - 1) % w.capacity]! : Infinity;
    if (w.count < w.capacity && playhead >= last) {
      // The series grew past a window with room left: read on from where it ends.
      void read(bound, Math.min(w.capacity - w.count, head - w.first - w.count));
    } else {
      void reload(bound, head);
    }
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
      if (bound.shown >= 0) deps.hold(bound.channel);
      bound.shown = -1;
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
    const chunk = Math.max(1, Math.min(elements, Math.floor(READ_BYTES / 16)));
    const step = Math.max(1, Math.floor(READ_BYTES / (8 * (chunk + 1))));
    for (let done = 0; done < frames; done += step) {
      const count = Math.min(step, frames - done);
      const position = w.count;
      for (let e = 0; e === 0 || e < elements; e += chunk) {
        const block = await series.read(
          bound.signal,
          {
            frameOffset: w.first + position,
            frameCount: count,
            elementOffset: e,
            elementCount: Math.min(chunk, elements - e),
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
            if (series.elements) w.values.fill(NaN, at, at + w.items);
          }
          const row = f * block.stride;
          const columns = Math.min(chunk, elements - e);
          for (let c = 0; c < columns; c++) {
            const item = series.elements ? series.elements[e + c]! : e + c;
            w.values[at + item] = block.values[row + c]!;
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
    deps.error(error instanceof Error ? error : new Error(String(error)));
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
    bound.loading?.abort();
    bound.loading = null;
    bound.off();
  }

  return {
    follow(channel, series, signal) {
      stop(channel);
      const window = windowFor(channel);
      window.first = window.count = window.start = 0;
      const bound: Bound = {
        channel,
        series,
        signal,
        window,
        shown: -1,
        loading: null,
        failed: false,
        off: () => {},
      };
      bound.off = series.on('append', () => {
        if (bounds.get(channel) !== bound) return;
        bound.failed = false;
        deps.appended(channel);
        show(bound);
      });
      bounds.set(channel, bound);
      show(bound);
    },

    stop,

    seek(time) {
      playhead = time;
      for (const bound of bounds.values()) show(bound);
    },

    upload(renderer) {
      renderer.reserve(words);
      for (const bound of bounds.values()) {
        renderer.writeWords(bound.window.base, bound.window.values);
      }
    },

    reset() {
      for (const channel of [...bounds.keys()]) stop(channel);
      windows.clear();
      words = deps.fixedWords();
    },
  };
}
