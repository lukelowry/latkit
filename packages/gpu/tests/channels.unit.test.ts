import { describe, expect, it, vi } from 'vitest';
import { type Domain, Engine, Model, Series } from '@latkit/model';

import { createChannels } from '../src/index.js';

/** A registry over two scopes: normalized, raw, paired, and channels that cannot follow. */
const REGISTRY = {
  color: { scope: 'a', normalized: true, components: 1, series: true },
  height: { scope: 'a', normalized: true, components: 1, series: true },
  flag: { scope: 'b', normalized: false, components: 1, series: true },
  place: { scope: 'a', normalized: false, components: 2, series: false },
  mask: { scope: 'b', normalized: false, components: 1, series: false },
} as const;

type Channel = keyof typeof REGISTRY;

const COUNTS = { a: 3, b: 2 };

interface Record {
  readonly offset: number;
  readonly bound: boolean;
  readonly min: number;
  readonly scale: number;
}

function harness(options: { loaded?: boolean; store?: boolean } = {}) {
  const records = new Map<Channel, Record>();
  const writes: Array<{ offset: number; values: number[] }> = [];
  const store = {
    reserved: 0,
    reserve: vi.fn((words: number) => {
      store.reserved = Math.max(store.reserved, words);
    }),
    writeWords: vi.fn((offset: number, values: Float32Array) => {
      writes.push({ offset, values: Array.from(values) });
    }),
  };
  let current: typeof store | null = options.store === false ? null : store;
  const shown = vi.fn();
  const error = vi.fn();
  const channels = createChannels<Channel, 'a' | 'b'>({
    name: 'test',
    structure: 'graph',
    channels: REGISTRY,
    store: () => current,
    record: (channel, offset, bound, min, scale) =>
      records.set(channel, { offset, bound, min, scale }),
    shown,
    error,
    initialDomain: (channel, values) => {
      if (channel !== 'height') return [0, 1];
      let lo = Infinity;
      let hi = -Infinity;
      for (const value of values) {
        if (!Number.isFinite(value)) continue;
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
      return lo <= hi ? [lo, hi] : [0, 1];
    },
  });
  channels.load(options.loaded === false ? null : COUNTS);
  writes.length = 0;
  return {
    channels,
    records,
    record: (channel: Channel) => records.get(channel)!,
    writes,
    store,
    shown,
    error,
    use: (next: boolean) => (current = next ? store : null),
  };
}

/** `frames` frames over `elements` items at times 0, 1, 2, …, item `e` of frame `f` being 10f + e. */
function recording(elements: number, frames: number, sparse?: Uint32Array) {
  return Series.create({
    signals: ['x', 'y'],
    elementCount: elements,
    time: Float64Array.from({ length: frames }, (_, f) => f),
    values: Float64Array.from({ length: 2 * frames * elements }, (_, i) => {
      const signal = Math.floor(i / (frames * elements));
      const at = i % (frames * elements);
      return 10 * Math.floor(at / elements) + (at % elements) + 1000 * signal;
    }),
    ...(sparse && { elements: sparse }),
  });
}

describe('channel layout', () => {
  it('gives every channel a slot in registry order, sized by its scope and components', () => {
    const h = harness();

    expect(h.channels.words).toBe(3 + 3 + 2 + 2 * 3 + 2);
    expect(h.channels.measure({ a: 1, b: 10 })).toBe(1 + 1 + 10 + 2 + 10);
    expect([...h.records.entries()].map(([key, value]) => [key, value.offset])).toEqual([
      ['color', 0],
      ['height', 3],
      ['flag', 6],
      ['place', 8],
      ['mask', 14],
    ]);
    for (const value of h.records.values())
      expect(value).toMatchObject({ bound: false, min: 0, scale: 0 });
  });

  it('lays out no slots before a load or after an unload', () => {
    const h = harness({ loaded: false });
    expect(h.channels.words).toBe(0);
    expect(h.record('mask').offset).toBe(0);
    expect(() => h.channels.set('color', new Float32Array(3))).toThrow(
      'test graph must be loaded before binding channels',
    );

    const loaded = harness();
    loaded.channels.set('flag', Float32Array.of(1, 0));
    loaded.channels.setDomain('color', [0, 2]);
    loaded.channels.load(null);
    expect(loaded.channels.words).toBe(0);
    expect(loaded.channels.values('flag')).toBeNull();
    expect(loaded.record('flag')).toEqual({ offset: 0, bound: false, min: 0, scale: 0 });
    expect(loaded.channels.set('color', null)).toBe(false);
  });
});

describe('bound arrays', () => {
  it('writes values into their slot, turns the channel on, and keeps its own copy', () => {
    const h = harness();
    const values = Float32Array.of(1, 0);

    expect(h.channels.set('flag', values)).toBe(true);

    expect(h.writes).toEqual([{ offset: 6, values: [1, 0] }]);
    expect(h.record('flag')).toEqual({ offset: 6, bound: true, min: 0, scale: 1 });
    const kept = h.channels.values('flag')!;
    expect(kept).not.toBe(values);
    values[0] = 9;
    expect(Array.from(kept)).toEqual([1, 0]);
  });

  it('refreshes the copy in place on a rebind, so animated values never allocate', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(0, 0.5, 1));
    const kept = h.channels.values('color');
    h.channels.set('color', Float32Array.of(1, 0.5, 0));
    expect(h.channels.values('color')).toBe(kept);
    expect(Array.from(kept!)).toEqual([1, 0.5, 0]);
  });

  it('stores float64 values as float32 and refuses anything else, changing nothing', () => {
    const h = harness();
    h.channels.set('color', Float64Array.of(0, 0.5, 1));
    expect(h.store.writeWords.mock.calls[0]![1]).toBeInstanceOf(Float32Array);
    expect(h.channels.values('color')).toEqual(Float32Array.of(0, 0.5, 1));
    h.writes.length = 0;

    expect(() => h.channels.set('flag', Int32Array.of(0, 1) as never)).toThrow(
      new TypeError('test channel flag values must be a Float32Array or Float64Array'),
    );
    expect(() => h.channels.set('flag', [0, 1] as never)).toThrow(TypeError);
    expect(() => h.channels.set('place', new Float32Array(3))).toThrow(
      'test channel place length 3 != 6',
    );
    expect(() => h.channels.set('ghost' as Channel, new Float32Array(3))).toThrow(
      'unknown test channel ghost',
    );
    expect(h.writes).toEqual([]);
    expect(h.channels.values('flag')).toBeNull();
    expect(h.record('flag').bound).toBe(false);
  });

  it('changes nothing when the store refuses the write', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(0, 0.5, 1), [0, 1]);
    const kept = h.channels.values('color');
    const record = h.record('color');
    h.store.writeWords.mockImplementationOnce(() => {
      throw new Error('upload failed');
    });

    expect(() => h.channels.set('color', Float32Array.of(1, 1, 1), [10, 20])).toThrow(
      'upload failed',
    );
    expect(h.channels.values('color')).toBe(kept);
    expect(Array.from(kept!)).toEqual([0, 0.5, 1]);
    expect(h.record('color')).toEqual(record);
  });

  it('keeps every value while no store exists and uploads them all into the next', () => {
    const h = harness({ store: false });
    h.channels.set('flag', Float32Array.of(1, 0));
    h.channels.set('place', Float32Array.of(0, 1, 2, 3, 4, 5));
    expect(h.writes).toEqual([]);

    h.use(true);
    h.channels.upload();
    expect(h.store.reserve).toHaveBeenCalledWith(h.channels.words);
    expect(h.writes).toEqual([
      { offset: 6, values: [1, 0] },
      { offset: 8, values: [0, 1, 2, 3, 4, 5] },
    ]);
  });

  it('clears to an unbound record at the slot, and says whether anything was bound', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(0, 1, 2), [0, 2]);
    h.channels.setDomain('color', [1, 2]);
    h.writes.length = 0;

    expect(h.channels.set('color', null)).toBe(true);
    expect(h.record('color')).toEqual({ offset: 0, bound: false, min: 0, scale: 0 });
    expect(h.channels.values('color')).toBeNull();
    expect(h.channels.domain('color')).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.channels.set('color', null)).toBe(false);
  });
});

describe('domains', () => {
  it('maps a normalized channel through its domain, else the one its values start with', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(5, 6, 7));
    expect(h.channels.domain('color')).toEqual([0, 1]);
    expect(h.record('color')).toMatchObject({ min: 0, scale: 1 });

    h.channels.set('height', Float32Array.of(2, NaN, 10));
    expect(h.channels.domain('height')).toEqual([2, 10]);
    expect(h.record('height')).toMatchObject({ min: 2, scale: 1 / 8 });

    const given: [number, number] = [1, 3];
    h.channels.set('color', Float32Array.of(1, 2, 3), given);
    given[0] = 100;
    expect(h.channels.domain('color')).toEqual([1, 3]);
    expect(h.record('color')).toMatchObject({ min: 1, scale: 0.5 });

    // A rebind without a domain returns to the one its values start with.
    h.channels.set('color', Float32Array.of(1, 2, 3));
    expect(h.channels.domain('color')).toEqual([0, 1]);
  });

  it('keeps a zero-width domain finite', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(2, 2, 2), [2, 2]);
    expect(Number.isFinite(h.record('color').scale)).toBe(true);
  });

  it('overrides a domain over rebinds until cleared, validating it first', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(1, 2, 3), [0, 10]);
    const override: [number, number] = [1, 3];
    h.channels.setDomain('color', override);
    override[0] = 20;
    expect(h.channels.domain('color')).toEqual([1, 3]);
    expect(h.record('color')).toMatchObject({ min: 1, scale: 0.5 });

    h.channels.set('color', Float32Array.of(1, 2, 3), [0, 4]);
    expect(h.channels.domain('color')).toEqual([1, 3]);
    h.channels.setDomain('color', null);
    expect(h.channels.domain('color')).toEqual([0, 4]);
    expect(h.record('color')).toMatchObject({ min: 0, scale: 0.25 });

    const record = h.record('color');
    for (const [bad, type] of [
      [[0], TypeError],
      [[0, '1'], TypeError],
      [[0, Number.NaN], RangeError],
      [[1, 0], RangeError],
    ] as const) {
      expect(() => h.channels.setDomain('color', bad as unknown as Domain)).toThrow(type);
      expect(() => h.channels.set('color', Float32Array.of(1, 2, 3), bad as never)).toThrow(type);
    }
    expect(h.record('color')).toEqual(record);
    expect(h.channels.domain('color')).toEqual([0, 4]);
  });

  it('writes nothing for an override it already holds, and holds one while unbound', () => {
    const h = harness();
    h.channels.setDomain('color', [0, 2]);
    const calls = h.records.get('color');
    h.records.delete('color');
    h.channels.setDomain('color', [0, 2]);
    expect(h.records.has('color')).toBe(false);
    h.records.set('color', calls!);
    expect(h.channels.domain('color')).toBeNull();

    h.channels.set('color', Float32Array.of(0, 1, 2));
    expect(h.channels.domain('color')).toEqual([0, 2]);
    // An override on an unbound channel is something a clear forgets.
    h.channels.set('color', null);
    h.channels.setDomain('height', [0, 1]);
    expect(h.channels.set('height', null)).toBe(true);
  });

  it('reads a raw channel through the identity and ignores any domain on it', () => {
    const h = harness();
    h.channels.set('flag', Float32Array.of(1, -1), [5, 6]);
    expect(() => h.channels.setDomain('flag', [Number.NaN, -Infinity] as Domain)).not.toThrow();
    expect(h.channels.domain('flag')).toBeNull();
    expect(h.record('flag')).toEqual({ offset: 6, bound: true, min: 0, scale: 1 });
  });

  it('writes a record again on refresh', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(0, 1, 2));
    h.records.clear();
    h.channels.refresh('color');
    expect(h.record('color')).toMatchObject({ offset: 0, bound: true });
  });
});

describe('followed series', () => {
  it('refuses a channel that cannot follow, a missing signal, and elements that do not fit', () => {
    const h = harness();
    const series = recording(3, 2);
    for (const channel of ['place', 'mask'] as const) {
      expect(() => h.channels.set(channel, { series, signal: 0 })).toThrow(
        new TypeError(`test channel ${channel} cannot follow a series`),
      );
    }
    expect(() => h.channels.set('color', { series, signal: 2 })).toThrow(
      new RangeError('test channel color signal 2 out of [0, 2)'),
    );
    expect(() => h.channels.set('flag', { series, signal: 0 })).toThrow(
      'test channel flag series elements do not fit 2 items',
    );
    expect(() =>
      h.channels.set('flag', { series: recording(1, 2, Uint32Array.of(2)), signal: 0 }),
    ).toThrow('do not fit 2 items');
    expect(() =>
      h.channels.set('color', { series: { series: null } as never, signal: 0 } as never),
    ).toThrow(TypeError);
    expect(() => harness({ loaded: false }).channels.set('color', { series, signal: 0 })).toThrow(
      'must be loaded',
    );
    expect(h.writes).toEqual([]);
  });

  it('shows NaN until a frame lands, then the frame at the playhead', async () => {
    const h = harness();
    const series = recording(3, 4);

    h.channels.set('color', { series, signal: 0 });

    expect(Array.from(h.channels.values('color')!)).toEqual([NaN, NaN, NaN]);
    expect(h.writes[0]).toEqual({ offset: 0, values: [NaN, NaN, NaN] });
    expect(h.record('color')).toMatchObject({ offset: 0, bound: true, min: 0 });
    expect(h.channels.domain('color')).toEqual([0, 32]);

    await vi.waitFor(() => expect(h.shown).toHaveBeenCalledWith('color'));
    const window = h.record('color').offset;
    expect(window).toBeGreaterThanOrEqual(h.channels.words);
    expect(Array.from(h.channels.values('color')!)).toEqual([0, 1, 2]);

    h.channels.seek(2);
    expect(h.record('color').offset).toBe(window + 2 * 3);
    expect(Array.from(h.channels.values('color')!)).toEqual([20, 21, 22]);
  });

  it('follows the recorded range as it grows, and keeps a domain it was given', async () => {
    const h = harness();
    const live = Series.create({ signals: ['x'], elementCount: 3 });
    h.channels.set('color', { series: live, signal: 0 });
    h.channels.set('height', { series: live, signal: 0 }, [0, 100]);
    expect(h.channels.domain('color')).toEqual([0, 1]);

    live.append({ time: Float64Array.of(0), values: Float64Array.of(-2, 5, 8) });
    expect(h.channels.domain('color')).toEqual([-2, 8]);
    expect(h.record('color')).toMatchObject({ min: -2, scale: 0.1 });
    expect(h.channels.domain('height')).toEqual([0, 100]);
    expect(h.shown).toHaveBeenCalledWith('color');
    await vi.waitFor(() => expect(h.shown).toHaveBeenCalledWith('height'));
  });

  it('pads a constant recorded range the way a field domain does', () => {
    const h = harness();
    const flat = Series.create({ signals: ['x'], elementCount: 3 });
    h.channels.set('color', { series: flat, signal: 0 });
    flat.append({ time: Float64Array.of(0), values: Float64Array.of(4, 4, 4) });
    expect(h.channels.domain('color')).toEqual([3.5, 4.5]);
    expect(h.record('color')).toMatchObject({ min: 3.5, scale: 1 });
  });

  it('follows a field gathered over another item axis, frame by frame', async () => {
    class Plant extends Model {
      constructor() {
        super({
          format: 'test',
          id: 'plant',
          name: 'Plant',
          topology: { vertexCount: 0, edges: new Uint32Array(0), polylineStart: Uint32Array.of(0) },
          classes: [
            {
              id: 'gen',
              label: 'Generator',
              count: 5,
              columns: [],
              signals: [{ id: 'P', label: 'Power', unit: 'MW', recorded: true }],
            },
          ],
        });
      }
      protected values(): Promise<Model.Values> {
        return Promise.resolve({ labels: ['a', 'b', 'c', 'd', 'e'], values: [] });
      }
      bytes(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(0));
      }
    }
    class Twice extends Engine {
      constructor() {
        super();
      }
      protected parse(input: unknown): unknown {
        return input;
      }
      protected execute(_model: Model, _input: unknown, recorder: Engine.Recorder): Promise<void> {
        recorder.append(Float64Array.of(0, 1), {
          gen: Float32Array.of(0, 1, 2, 3, 4, 10, 11, 12, 13, 14),
        });
        return Promise.resolve();
      }
    }
    const model = new Plant();
    model.engine = new Twice();
    const recording = model.record(null);
    await vi.waitFor(() => expect(recording.state.status).toBe('complete'));
    const power = (await model.field({ classId: 'gen', kind: 'signal', id: 'P' }, recording))!;
    const h = harness();
    h.channels.set('color', power.gather([4, 0xffffffff, 0]));
    expect(h.channels.domain('color')).toEqual([0, 14]);
    await vi.waitFor(() => expect(Array.from(h.channels.values('color')!)).toEqual([4, NaN, 0]));
    h.channels.seek(1);
    expect(Array.from(h.channels.values('color')!)).toEqual([14, NaN, 10]);
  });

  it('keeps what a channel shows when it follows the same signal again', async () => {
    const h = harness();
    const series = recording(3, 4);
    h.channels.set('color', { series, signal: 0 });
    await vi.waitFor(() => expect(h.shown).toHaveBeenCalled());
    const shown = h.channels.values('color');
    const offset = h.record('color').offset;

    h.channels.set('color', { series, signal: 0 }, [0, 10]);
    expect(h.channels.values('color')).toBe(shown);
    expect(h.record('color')).toMatchObject({ offset, min: 0, scale: 0.1 });
  });

  it('shares one window between channels following one signal', async () => {
    const h = harness();
    const series = recording(3, 4);
    h.channels.set('color', { series, signal: 1 });
    await vi.waitFor(() => expect(h.shown).toHaveBeenCalled());
    const reserved = h.store.reserve.mock.calls.length;

    h.channels.set('height', { series, signal: 1 });
    expect(h.store.reserve).toHaveBeenCalledTimes(reserved);
    expect(h.record('height').offset).toBe(h.record('color').offset);
    expect(Array.from(h.channels.values('height')!)).toEqual([1000, 1001, 1002]);
  });

  it('returns to its own slot when an array replaces the series', async () => {
    const h = harness();
    const series = recording(3, 4);
    h.channels.set('color', { series, signal: 0 });
    await vi.waitFor(() => expect(h.shown).toHaveBeenCalled());
    const window = h.channels.values('color')!;
    h.writes.length = 0;

    h.channels.set('color', Float32Array.of(7, 8, 9));
    expect(h.record('color').offset).toBe(0);
    expect(h.writes).toEqual([{ offset: 0, values: [7, 8, 9] }]);
    expect(Array.from(h.channels.values('color')!)).toEqual([7, 8, 9]);
    expect(Array.from(window)).toEqual([0, 1, 2]);
    expect(h.channels.domain('color')).toEqual([0, 1]);
    h.shown.mockClear();
    h.channels.seek(3);
    expect(h.shown).not.toHaveBeenCalled();
  });

  it('holds what it shows in its own slot while the window under it is rewritten', async () => {
    const h = harness();
    // More frames than one window holds, so a far seek reads a new window.
    const series = recording(3, 1000);
    h.channels.set('color', { series, signal: 0 });
    await vi.waitFor(() => expect(h.shown).toHaveBeenCalled());
    h.writes.length = 0;

    h.channels.seek(900);
    await vi.waitFor(() => expect(h.writes[0]).toEqual({ offset: 0, values: [0, 1, 2] }));
    await vi.waitFor(() =>
      expect(Array.from(h.channels.values('color')!)).toEqual([9000, 9001, 9002]),
    );
  });

  it('clears a followed channel back to its own slot', async () => {
    const h = harness();
    h.channels.set('color', { series: recording(3, 4), signal: 0 });
    await vi.waitFor(() => expect(h.shown).toHaveBeenCalled());

    expect(h.channels.set('color', null)).toBe(true);
    expect(h.record('color')).toEqual({ offset: 0, bound: false, min: 0, scale: 0 });
    expect(h.channels.values('color')).toBeNull();
  });

  it('leaves the channel unbound when the store cannot hold its window', () => {
    const h = harness();
    h.channels.set('color', Float32Array.of(1, 2, 3));
    h.store.reserve.mockImplementationOnce(() => {
      throw new Error('out of memory');
    });

    expect(() => h.channels.set('color', { series: recording(3, 4), signal: 0 })).toThrow(
      'out of memory',
    );
    expect(h.channels.values('color')).toBeNull();
    expect(h.record('color').bound).toBe(false);
  });

  it('says when a read fails', async () => {
    const h = harness();
    const failing = recording(3, 4);
    vi.spyOn(failing, 'read').mockRejectedValue(new Error('gone'));
    h.channels.set('color', { series: failing, signal: 0 });
    await vi.waitFor(() => expect(h.error).toHaveBeenCalledWith('color', new Error('gone')));
  });

  it('uploads every window into the next store', async () => {
    const h = harness();
    h.channels.set('color', { series: recording(3, 4), signal: 0 });
    await vi.waitFor(() => expect(h.shown).toHaveBeenCalled());
    h.writes.length = 0;

    h.channels.upload();
    expect(h.writes[0]).toEqual({ offset: 0, values: [NaN, NaN, NaN] });
    expect(h.writes.at(-1)!.offset).toBeGreaterThanOrEqual(h.channels.words);
  });
});
