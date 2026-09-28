/**
 * Series followed around a playhead: the frames of each followed signal stay resident in a window
 * of a renderer's store, shared by every key following that signal, and showing a frame hands a
 * key its offset in the store, so a seek within the window writes nothing. The window is two
 * halves; once the playhead passes into the later one, or past the last frame as the series
 * appends, the next frames load into the half already played, so steady playback reads ahead while
 * it plays.
 */

import type { Series } from './series.js';

/** What one window takes in the store; its CPU copy takes as much again. */
const WINDOW_BYTES = 8 * 1024 * 1024;
/** What one series read may carry, time included. */
const READ_BYTES = 1024 * 1024;

/** Series signals followed around one playhead, for the keys a renderer binds them to. */
export interface Playback<Key> {
  /**
   * Follow one signal of `series` for `key`, replacing what it followed. Following the signal it
   * already follows keeps what it shows; a signal another key follows shares that key's frames.
   * Either reads again after a failure.
   *
   * @throws Error when the store cannot hold another window; `key` then follows nothing.
   */
  follow(key: Key, series: Series, signal: number): void;
  /** Stop following for `key`. */
  stop(key: Key): void;
  /**
   * Show every followed signal at `time`: each value takes its latest sample at or before it, or
   * its first before the recording starts.
   *
   * @throws RangeError when `time` is not finite.
   */
  seek(time: number): void;
  /** Write every window into the store again, as into one just created. */
  upload(): void;
  /** Stop following for every key and forget every window, as for a new layout of the store. */
  reset(): void;
}

/** Resident frames of one signal, in two halves of a ring of slots. */
interface Window {
  /** Word offset of slot 0 in the store. */
  readonly base: number;
  readonly items: number;
  /** Slots, an even count: two halves. */
  readonly capacity: number;
  /** Frame times by slot. */
  readonly time: Float64Array;
  /** Values by slot, `items` each: the CPU copy, uploaded again on request and read by keys. */
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

/** One series signal and the keys following it. */
interface Bound<Key> {
  readonly series: Series;
  readonly signal: number;
  readonly window: Window;
  /** Every key following it; the first stands for it wherever the bound is visited once. */
  readonly keys: Key[];
  /** The slot shown, or -1 while the keys' own words hold what is shown. */
  shown: number;
  loading: AbortController | null;
  /** A read failed; nothing is read again until the series appends or a key follows it anew. */
  failed: boolean;
  off: () => void;
}

/**
 * The resident position of the latest frame at or before `time`, or -1 when it isn't resident. A
 * time before the series' first frame shows that frame.
 */
function slotAt(w: Window, time: number, head: number): number {
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

/**
 * Create the playback a renderer's channels share: each follows one signal of a series, and a seek
 * shows every one at a playhead.
 *
 * @remarks
 * Each followed signal takes a window of about 8 MiB after the store's reserved words, 2 to 256
 * frames of `items(key)` values, plus a CPU copy as large whose views `show` hands to the keys.
 */
export function createPlayback<Key>(spec: {
  /** Words the store keeps before any window. */
  reserved(): number;
  /** Values a frame holds for `key`: one per item of its scope. */
  items(key: Key): number;
  /**
   * The store windows live in, or null while there is none. `reserve` grows it to hold `words`
   * float words, keeping what it holds, and throws when it cannot.
   */
  store(): {
    reserve(words: number): void;
    writeWords(offset: number, values: Float32Array): void;
  } | null;
  /** Show `key` the values `offset` words into the store, which it reads on the CPU as `view`. */
  show(key: Key, offset: number, view: Float32Array): void;
  /** Keep what `key` shows in its own words while the window under it is rewritten. */
  hold(key: Key): void;
  /** The series `key` follows appended: its recorded range may have grown. */
  appended(key: Key): void;
  /** A read of the series `key` follows failed. */
  error(key: Key, cause: unknown): void;
}): Playback<Key> {
  /** What each following key follows; keys following one signal share it. */
  const bounds = new Map<Key, Bound<Key>>();
  /** Windows no signal holds, by the items they fit, reused before the store grows. */
  const idle = new Map<number, Window[]>();
  /** Words the store must hold: its reserved words and every window. */
  let words = spec.reserved();
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
    const grown = words + capacity * items;
    // A store that cannot hold the window throws before anything changes.
    spec.store()?.reserve(grown);
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
    words = grown;
    return window;
  }

  /** Show `bound` at the playhead, reading what it needs that isn't resident. */
  function show(bound: Bound<Key>): void {
    const w = bound.window;
    const head = bound.series.state.frameCount;
    const half = w.capacity / 2;
    const position = slotAt(w, playhead, head);
    if (position >= 0) {
      const slot = (w.start + position) % w.capacity;
      if (slot !== bound.shown) {
        bound.shown = slot;
        for (const key of bound.keys) spec.show(key, w.base + slot * w.items, w.views[slot]!);
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

  /** Keep what `bound` shows in its keys' own words, so its window can be rewritten. */
  function hold(bound: Bound<Key>): void {
    if (bound.shown < 0) return;
    for (const key of bound.keys) spec.hold(key);
    bound.shown = -1;
  }

  /** Drop the half of the window played first, holding a frame shown from it. */
  function advance(bound: Bound<Key>): void {
    const w = bound.window;
    const half = w.capacity / 2;
    if (bound.shown >= 0 && (bound.shown - w.start + w.capacity) % w.capacity < half) hold(bound);
    w.first += half;
    w.count -= half;
    w.start = (w.start + half) % w.capacity;
  }

  /** Read a window around the playhead: a quarter behind it, the rest ahead. */
  async function reload(bound: Bound<Key>, head: number): Promise<void> {
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
  async function read(bound: Bound<Key>, frames: number): Promise<void> {
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
  async function fill(bound: Bound<Key>, signal: AbortSignal, frames: number): Promise<void> {
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
    const store = spec.store();
    if (!store) return;
    const slot = (w.start + position) % w.capacity;
    const first = Math.min(count, w.capacity - slot);
    store.writeWords(
      w.base + slot * w.items,
      w.values.subarray(slot * w.items, (slot + first) * w.items),
    );
    if (first < count) {
      store.writeWords(w.base, w.values.subarray(0, (count - first) * w.items));
    }
  }

  function fail(bound: Bound<Key>, job: AbortController, error: unknown): void {
    if (job.signal.aborted || bound.loading !== job) return;
    bound.failed = true;
    for (const key of bound.keys) spec.error(key, error);
  }

  /** End a read; show again at the playhead, which may have moved on while it ran. */
  function settle(bound: Bound<Key>, job: AbortController): void {
    if (bound.loading !== job) return;
    bound.loading = null;
    if (!job.signal.aborted && !bound.failed) show(bound);
  }

  function stop(key: Key): void {
    const bound = bounds.get(key);
    if (!bound) return;
    bounds.delete(key);
    bound.keys.splice(bound.keys.indexOf(key), 1);
    if (bound.keys.length) return;
    bound.loading?.abort();
    bound.loading = null;
    bound.off();
    const windows = idle.get(bound.window.items);
    if (windows) windows.push(bound.window);
    else idle.set(bound.window.items, [bound.window]);
  }

  /** `key` joins `bound`, shown what it shows, and a failed read is tried again. */
  function join(key: Key, bound: Bound<Key>): void {
    if (bounds.get(key) !== bound) {
      stop(key);
      bounds.set(key, bound);
      bound.keys.push(key);
      const w = bound.window;
      if (bound.shown >= 0) spec.show(key, w.base + bound.shown * w.items, w.views[bound.shown]!);
    }
    bound.failed = false;
    show(bound);
  }

  return {
    follow(key, series, signal) {
      const items = spec.items(key);
      for (const bound of bounds.values()) {
        if (bound.series === series && bound.signal === signal && bound.window.items === items) {
          join(key, bound);
          return;
        }
      }
      stop(key);
      const bound: Bound<Key> = {
        series,
        signal,
        window: windowFor(items),
        keys: [key],
        shown: -1,
        loading: null,
        failed: false,
        off: () => {},
      };
      bound.off = series.on('append', () => {
        if (!bound.keys.length) return;
        bound.failed = false;
        for (const following of bound.keys) spec.appended(following);
        show(bound);
      });
      bounds.set(key, bound);
      show(bound);
    },

    stop,

    seek(time) {
      if (!Number.isFinite(time)) throw new RangeError('seek time must be finite');
      playhead = time;
      for (const [key, bound] of bounds) if (bound.keys[0] === key) show(bound);
    },

    upload() {
      const store = spec.store();
      if (!store) return;
      store.reserve(words);
      for (const [key, bound] of bounds) {
        if (bound.keys[0] === key) store.writeWords(bound.window.base, bound.window.values);
      }
    },

    reset() {
      for (const key of [...bounds.keys()]) stop(key);
      idle.clear();
      words = spec.reserved();
    },
  };
}
