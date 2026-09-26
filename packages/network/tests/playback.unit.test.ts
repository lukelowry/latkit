import { describe, expect, it, vi } from 'vitest';

import { createSeries, type Series } from '@latkit/model';

import type { Channel } from '../src/channels.js';
import { createPlayback, type PlaybackRenderer } from '../src/playback.js';

const FIXED = 100;

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

function harness(items: number) {
  const moves: Array<{ channel: Channel; offset: number; view: number[] }> = [];
  const holds: Channel[] = [];
  const errors: Error[] = [];
  const appended = vi.fn();
  const writes: Array<{ offset: number; values: number[] }> = [];
  const renderer: PlaybackRenderer & { reserved: number } = {
    reserved: 0,
    reserve: vi.fn((words: number) => {
      renderer.reserved = words;
    }),
    writeWords: vi.fn((offset: number, values: Float32Array) => {
      writes.push({ offset, values: Array.from(values) });
    }),
  };
  let attached: PlaybackRenderer | null = renderer;
  const playback = createPlayback({
    fixedWords: () => FIXED,
    items: () => items,
    renderer: () => attached,
    moveTo: (channel, offset, view) => moves.push({ channel, offset, view: Array.from(view) }),
    hold: (channel) => holds.push(channel),
    appended,
    error: (error) => errors.push(error),
  });
  playback.reset();
  return {
    playback,
    moves,
    holds,
    errors,
    appended,
    writes,
    renderer,
    detach: () => (attached = null),
    shown: () => moves.at(-1)!,
  };
}

/** Slot `slot` of a window at word FIXED over `items` items. */
const offsetOf = (slot: number, items = 3) => FIXED + slot * items;

describe('series-bound channels', () => {
  it('reads a window from the first frame and shows it once it lands', async () => {
    const h = harness(3);
    const s = series(3, 10);

    h.playback.follow('vertexColor', s.series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(1));

    expect(h.shown()).toEqual({ channel: 'vertexColor', offset: offsetOf(0), view: [0, 1, 2] });
    // 256 slots of 3 items reserved after the fixed ones; the 10 frames uploaded.
    expect(h.renderer.reserved).toBe(FIXED + 256 * 3);
    expect(h.writes).toEqual([
      {
        offset: FIXED,
        values: Array.from({ length: 30 }, (_, i) => 10 * Math.floor(i / 3) + (i % 3)),
      },
    ]);
  });

  it('seeks within the window without reading: the latest frame at or before, the first before any', async () => {
    const h = harness(3);
    const s = series(3, 10);
    h.playback.follow('vertexColor', s.series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(1));
    s.read.mockClear();

    h.playback.seek(7);
    expect(h.shown()).toMatchObject({ offset: offsetOf(7), view: [70, 71, 72] });
    h.playback.seek(4.5);
    expect(h.shown()).toMatchObject({ offset: offsetOf(4) });
    h.playback.seek(99);
    expect(h.shown()).toMatchObject({ offset: offsetOf(9) });
    h.playback.seek(-5);
    expect(h.shown()).toMatchObject({ offset: offsetOf(0) });
    const moves = h.moves.length;
    h.playback.seek(-1);
    expect(h.moves).toHaveLength(moves);
    expect(s.read).not.toHaveBeenCalled();
  });

  it('holds the shown frame and reads a new window around a seek beyond it', async () => {
    const h = harness(3);
    const s = series(3, 1000);
    h.playback.follow('vertexColor', s.series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(1));

    h.playback.seek(900);
    await vi.waitFor(() => expect(h.shown().view).toEqual([9000, 9001, 9002]));
    expect(h.holds).toEqual(['vertexColor']);
    // A quarter window behind the playhead would pass the end: the window ends at the last frame.
    expect(h.shown().offset).toBe(offsetOf(900 - 744));
    expect(s.read.mock.calls.at(-1)![1]).toMatchObject({ frameOffset: 744 });
  });

  it('reads the next half into the half already played once the playhead passes the middle', async () => {
    const h = harness(3);
    const s = series(3, 1000);
    h.playback.follow('vertexColor', s.series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(1));
    s.read.mockClear();
    const writes = h.writes.length;

    h.playback.seek(128);
    await vi.waitFor(() => expect(h.writes).toHaveLength(writes + 1));
    expect(h.writes.at(-1)!.offset).toBe(FIXED);
    expect(s.read.mock.calls.map(([, window]) => window.frameOffset)).toEqual([256]);
    expect(h.writes.at(-1)!.values.slice(0, 3)).toEqual([2560, 2561, 2562]);

    h.playback.seek(300);
    expect(h.shown()).toEqual({
      channel: 'vertexColor',
      offset: offsetOf(300 - 256),
      view: [3000, 3001, 3002],
    });
    expect(h.holds).toEqual([]);
  });

  it('reads on as a live series appends, and follows its recorded range', async () => {
    const h = harness(3);
    const s = series(3, 10);
    h.playback.follow('vertexColor', s.series, 0);
    h.playback.seek(9);
    await vi.waitFor(() => expect(h.shown().offset).toBe(offsetOf(9)));
    s.read.mockClear();

    s.append(5);
    expect(h.appended).toHaveBeenCalledExactlyOnceWith('vertexColor');
    h.playback.seek(14);
    await vi.waitFor(() =>
      expect(h.shown()).toMatchObject({ offset: offsetOf(14), view: [140, 141, 142] }),
    );
    expect(s.read).toHaveBeenCalledOnce();
    expect(s.read.mock.calls[0]![1]).toMatchObject({ frameOffset: 10, frameCount: 5 });
    expect(h.holds).toEqual([]);
  });

  it('leaves the items a sparse series never recorded NaN', async () => {
    const h = harness(3);
    const s = series(3, 2, Uint32Array.of(0, 2));
    h.playback.follow('edgeColor', s.series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(1));
    expect(h.shown().view).toEqual([0, NaN, 2]);
  });

  it('reports a failed read once, and reads again only after the series appends', async () => {
    const h = harness(3);
    const s = series(3, 10);
    s.fail(new Error('disk on fire'));
    h.playback.follow('vertexColor', s.series, 0);
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    expect(h.errors[0]!.message).toBe('disk on fire');

    h.playback.seek(3);
    h.playback.seek(4);
    expect(s.read).toHaveBeenCalledOnce();
    expect(h.errors).toHaveLength(1);

    s.fail(null);
    s.append(1);
    await vi.waitFor(() => expect(h.shown()).toMatchObject({ offset: offsetOf(4) }));
  });

  it('stops a read in flight, and a new binding reuses the channel window', async () => {
    const h = harness(3);
    const s = series(3, 10);
    const open = s.hold();
    h.playback.follow('vertexColor', s.series, 0);
    await vi.waitFor(() => expect(s.read).toHaveBeenCalled());
    h.playback.stop('vertexColor');
    open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.moves).toEqual([]);

    const reserved = h.renderer.reserved;
    h.playback.follow('vertexColor', series(3, 4).series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(1));
    expect(h.shown().offset).toBe(offsetOf(0));
    expect(h.renderer.reserved).toBe(reserved);
  });

  it('keeps reading while detached and replays every window into the next renderer', async () => {
    const h = harness(3);
    h.detach();
    const s = series(3, 3);
    h.playback.follow('vertexColor', s.series, 0);
    h.playback.follow('edgeColor', series(3, 2).series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(2));
    expect(h.writes).toEqual([]);

    const next = {
      reserve: vi.fn<PlaybackRenderer['reserve']>(),
      writeWords: vi.fn<PlaybackRenderer['writeWords']>(),
    };
    h.playback.upload(next);
    expect(next.reserve).toHaveBeenCalledExactlyOnceWith(FIXED + 2 * 256 * 3);
    expect(next.writeWords.mock.calls.map(([offset]) => offset)).toEqual([FIXED, FIXED + 256 * 3]);
    expect(Array.from(next.writeWords.mock.calls[0]![1]).slice(0, 9)).toEqual([
      0, 1, 2, 10, 11, 12, 20, 21, 22,
    ]);
  });

  it('sizes a window to about 8 MiB, from 2 to 256 frames', async () => {
    const h = harness(100_000);
    const s = series(100_000, 1);
    h.playback.follow('vertexColor', s.series, 0);
    await vi.waitFor(() => expect(h.moves).toHaveLength(1));
    expect(h.renderer.reserved).toBe(FIXED + 20 * 100_000);
  });
});
