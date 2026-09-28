import { describe, expect, it, vi } from 'vitest';

import { createPlayback, createSeries, type Series } from '../src/index.js';

const RESERVED = 100;

/** A series of `frames` frames at times 0, 1, 2, …, where item `e` of frame `f` is `10f + e`. */
function series(items: number, frames: number, elements?: Uint32Array) {
  const stored = elements?.length ?? items;
  const live = createSeries({ elementCount: stored, signalCount: 1, elements });
  const append = (count: number): void => {
    const from = live.state.frameCount;
    live.append({
      elementCount: stored,
      signalCount: 1,
      ...(elements && { elements }),
      time: Float64Array.from({ length: count }, (_, i) => from + i),
      values: Float64Array.from(
        { length: count * stored },
        (_, i) => 10 * (from + Math.floor(i / stored)) + (elements?.[i % stored] ?? i % stored),
      ),
    });
  };
  if (frames > 0) append(frames);
  let gate: Promise<void> | null = null;
  let failure: Error | null = null;
  const read = vi.fn<Series['read']>(async (...args) => {
    if (gate) await gate;
    if (failure) throw failure;
    return live.read(...args);
  });
  const wrapped: Series = {
    ...live,
    get state() {
      return live.state;
    },
    read,
  };
  return {
    series: wrapped,
    read,
    append,
    hold(): () => void {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
    fail(error: Error | null): void {
      failure = error;
    },
  };
}

interface Store {
  reserve(words: number): void;
  writeWords(offset: number, values: Float32Array): void;
}

function harness(items: number) {
  const shows: Array<{ key: string; offset: number; view: number[] }> = [];
  const holds: string[] = [];
  const errors: Array<{ key: string; cause: unknown }> = [];
  const appended = vi.fn();
  const writes: Array<{ offset: number; values: number[] }> = [];
  const store: Store & { reserved: number } = {
    reserved: 0,
    reserve: vi.fn((words: number) => {
      store.reserved = words;
    }),
    writeWords: vi.fn((offset: number, values: Float32Array) => {
      writes.push({ offset, values: Array.from(values) });
    }),
  };
  let current: Store | null = store;
  const playback = createPlayback<string>({
    reserved: () => RESERVED,
    items: () => items,
    store: () => current,
    show: (key, offset, view) => shows.push({ key, offset, view: Array.from(view) }),
    hold: (key) => holds.push(key),
    appended,
    error: (key, cause) => errors.push({ key, cause }),
  });
  return {
    playback,
    shows,
    holds,
    errors,
    appended,
    writes,
    store,
    use: (next: Store | null) => (current = next),
    shown: () => shows.at(-1)!,
  };
}

/** Slot `slot` of a window after the reserved words, over `items` items. */
const offsetOf = (slot: number, items = 3) => RESERVED + slot * items;

describe('playback', () => {
  it('reads a window from the first frame and shows it once it lands', async () => {
    const h = harness(3);
    const s = series(3, 10);

    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));

    expect(h.shown()).toEqual({ key: 'a', offset: offsetOf(0), view: [0, 1, 2] });
    // 256 slots of 3 items after the reserved words; the 10 frames uploaded.
    expect(h.store.reserved).toBe(RESERVED + 256 * 3);
    expect(h.writes).toEqual([
      {
        offset: RESERVED,
        values: Array.from({ length: 30 }, (_, i) => 10 * Math.floor(i / 3) + (i % 3)),
      },
    ]);
  });

  it('seeks within the window without reading: the latest frame at or before, the first before any', async () => {
    const h = harness(3);
    const s = series(3, 10);
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));
    s.read.mockClear();

    h.playback.seek(7);
    expect(h.shown()).toMatchObject({ offset: offsetOf(7), view: [70, 71, 72] });
    h.playback.seek(4.5);
    expect(h.shown()).toMatchObject({ offset: offsetOf(4) });
    h.playback.seek(99);
    expect(h.shown()).toMatchObject({ offset: offsetOf(9) });
    h.playback.seek(-5);
    expect(h.shown()).toMatchObject({ offset: offsetOf(0) });
    const shows = h.shows.length;
    h.playback.seek(-1);
    expect(h.shows).toHaveLength(shows);
    expect(s.read).not.toHaveBeenCalled();
    expect(() => h.playback.seek(Number.NaN)).toThrow(RangeError);
  });

  it('holds the shown frame and reads a new window around a seek beyond it', async () => {
    const h = harness(3);
    const s = series(3, 1000);
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));

    h.playback.seek(900);
    await vi.waitFor(() => expect(h.shown().view).toEqual([9000, 9001, 9002]));
    expect(h.holds).toEqual(['a']);
    // A quarter window behind the playhead would pass the end: the window ends at the last frame.
    expect(h.shown().offset).toBe(offsetOf(900 - 744));
    expect(s.read.mock.calls.at(-1)![1]).toMatchObject({ frameOffset: 744 });
  });

  it('reads the next half into the half already played once the playhead passes the middle', async () => {
    const h = harness(3);
    const s = series(3, 1000);
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));
    s.read.mockClear();
    const writes = h.writes.length;

    h.playback.seek(128);
    await vi.waitFor(() => expect(h.writes).toHaveLength(writes + 1));
    expect(h.writes.at(-1)!.offset).toBe(RESERVED);
    expect(s.read.mock.calls.map(([, window]) => window.frameOffset)).toEqual([256]);
    expect(h.writes.at(-1)!.values.slice(0, 3)).toEqual([2560, 2561, 2562]);

    h.playback.seek(300);
    expect(h.shown()).toEqual({ key: 'a', offset: offsetOf(300 - 256), view: [3000, 3001, 3002] });
    expect(h.holds).toEqual([]);
  });

  it('reads on as a live series appends, and says it appended', async () => {
    const h = harness(3);
    const s = series(3, 10);
    h.playback.follow('a', s.series, 0);
    h.playback.seek(9);
    await vi.waitFor(() => expect(h.shown().offset).toBe(offsetOf(9)));
    s.read.mockClear();

    s.append(5);
    expect(h.appended).toHaveBeenCalledExactlyOnceWith('a');
    h.playback.seek(14);
    await vi.waitFor(() =>
      expect(h.shown()).toMatchObject({ offset: offsetOf(14), view: [140, 141, 142] }),
    );
    expect(s.read).toHaveBeenCalledOnce();
    expect(s.read.mock.calls[0]![1]).toMatchObject({ frameOffset: 10, frameCount: 5 });
    expect(h.holds).toEqual([]);
  });

  it('reads on one appended frame at a time while the playhead follows a live head', async () => {
    const h = harness(3);
    // Exactly one full window of 256 frames.
    const s = series(3, 256);
    h.playback.follow('a', s.series, 0);
    h.playback.seek(255);
    await vi.waitFor(() => expect(h.shown().view).toEqual([2550, 2551, 2552]));
    s.read.mockClear();

    for (let frame = 256; frame < 266; frame++) {
      s.append(1);
      h.playback.seek(frame);
      await vi.waitFor(() =>
        expect(h.shown().view).toEqual([10 * frame, 10 * frame + 1, 10 * frame + 2]),
      );
    }
    expect(s.read.mock.calls.map(([, window]) => window.frameCount)).toEqual(Array(10).fill(1));
    expect(h.holds).toEqual([]);
  });

  it('leaves the items a sparse series never recorded NaN', async () => {
    const h = harness(3);
    const s = series(3, 2, Uint32Array.of(0, 2));
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));
    expect(h.shown().view).toEqual([0, NaN, 2]);
  });

  it('reports a failed read once, and reads again only after the series appends', async () => {
    const h = harness(3);
    const s = series(3, 10);
    const cause = new Error('disk on fire');
    s.fail(cause);
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.errors).toEqual([{ key: 'a', cause }]));

    h.playback.seek(3);
    h.playback.seek(4);
    expect(s.read).toHaveBeenCalledOnce();
    expect(h.errors).toHaveLength(1);

    s.fail(null);
    s.append(1);
    await vi.waitFor(() => expect(h.shown()).toMatchObject({ offset: offsetOf(4) }));
  });

  it('shares one window among the keys following one signal', async () => {
    const h = harness(3);
    const s = series(3, 10);
    h.playback.follow('a', s.series, 0);
    h.playback.follow('b', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(2));
    expect(h.shows.map(({ key, offset }) => [key, offset])).toEqual([
      ['a', offsetOf(0)],
      ['b', offsetOf(0)],
    ]);
    expect(s.read).toHaveBeenCalledOnce();
    expect(h.store.reserved).toBe(RESERVED + 256 * 3);

    h.playback.seek(4);
    expect(h.shows.slice(-2).map(({ offset }) => offset)).toEqual([offsetOf(4), offsetOf(4)]);
    h.playback.stop('a');
    h.playback.seek(5);
    expect(h.shown()).toMatchObject({ key: 'b', offset: offsetOf(5) });
    expect(h.shows).toHaveLength(5);
  });

  it('keeps what a key shows when it follows the same signal again, and retries a failure', async () => {
    const h = harness(3);
    const s = series(3, 10);
    h.playback.follow('a', s.series, 0);
    h.playback.seek(5);
    await vi.waitFor(() => expect(h.shown()).toMatchObject({ offset: offsetOf(5) }));
    const shows = h.shows.length;
    h.playback.follow('a', s.series, 0);
    expect(h.shows).toHaveLength(shows);
    expect(s.read).toHaveBeenCalledOnce();

    const failing = series(3, 10);
    failing.fail(new Error('disk on fire'));
    h.playback.follow('a', failing.series, 0);
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    failing.fail(null);
    h.playback.follow('a', failing.series, 0);
    await vi.waitFor(() => expect(h.shown()).toMatchObject({ view: [50, 51, 52] }));
  });

  it('stops a read in flight, and a new signal reuses the window it leaves', async () => {
    const h = harness(3);
    const s = series(3, 10);
    const open = s.hold();
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(s.read).toHaveBeenCalled());
    h.playback.stop('a');
    open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.shows).toEqual([]);

    const reserved = h.store.reserved;
    h.playback.follow('a', series(3, 4).series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));
    expect(h.shown().offset).toBe(offsetOf(0));
    expect(h.store.reserved).toBe(reserved);
  });

  it('refuses a window the store cannot hold, and the key then follows nothing', async () => {
    const h = harness(3);
    const s = series(3, 10);
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));
    vi.mocked(h.store.reserve).mockImplementationOnce(() => {
      throw new Error('storage limit');
    });

    expect(() => h.playback.follow('b', series(3, 10).series, 0)).toThrow('storage limit');
    h.playback.seek(3);
    expect(h.shows.every(({ key }) => key === 'a')).toBe(true);
    // The refused window took no words: the next store holds only the one that fits.
    const next = { reserve: vi.fn<Store['reserve']>(), writeWords: vi.fn<Store['writeWords']>() };
    h.use(next);
    h.playback.upload();
    expect(next.reserve).toHaveBeenCalledExactlyOnceWith(RESERVED + 256 * 3);
  });

  it('keeps reading without a store and uploads every window into the next one', async () => {
    const h = harness(3);
    h.use(null);
    h.playback.follow('a', series(3, 3).series, 0);
    h.playback.follow('b', series(3, 2).series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(2));
    expect(h.writes).toEqual([]);

    const next = { reserve: vi.fn<Store['reserve']>(), writeWords: vi.fn<Store['writeWords']>() };
    h.use(next);
    h.playback.upload();
    expect(next.reserve).toHaveBeenCalledExactlyOnceWith(RESERVED + 2 * 256 * 3);
    expect(next.writeWords.mock.calls.map(([offset]) => offset)).toEqual([
      RESERVED,
      RESERVED + 256 * 3,
    ]);
    expect(Array.from(next.writeWords.mock.calls[0]![1]).slice(0, 9)).toEqual([
      0, 1, 2, 10, 11, 12, 20, 21, 22,
    ]);
  });

  it('sizes a window to about 8 MiB, from 2 to 256 frames', async () => {
    const h = harness(100_000);
    const s = series(100_000, 1);
    h.playback.follow('a', s.series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(1));
    expect(h.store.reserved).toBe(RESERVED + 20 * 100_000);
  });

  it('forgets every window on reset, starting again after the reserved words', async () => {
    const h = harness(3);
    h.playback.follow('a', series(3, 3).series, 0);
    h.playback.follow('b', series(3, 3).series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(2));

    h.playback.reset();
    h.playback.follow('a', series(3, 3).series, 0);
    await vi.waitFor(() => expect(h.shows).toHaveLength(3));
    expect(h.shown().offset).toBe(offsetOf(0));
  });
});
