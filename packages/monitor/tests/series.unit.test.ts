// @vitest-environment jsdom
import { createEmitter, createSeries, position, type Domain, type Series } from '@latkit/model';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMonitor, type Monitor, type Options, type Reading } from '../src/index.js';
import { installGpuStub, type GpuStub } from './gpu-stub.js';
type Window = Parameters<Series['read']>[1];
let stub: GpuStub, monitor: Monitor;
beforeEach(() => {
  stub = installGpuStub();
  monitor = createMonitor({ devices: stub.pool });
});
afterEach(() => {
  monitor.destroy();
  stub.teardown();
  document.body.replaceChildren();
});
function canvas(width = 320) {
  const element = document.createElement('canvas');
  Object.defineProperties(element, { clientWidth: { value: width }, clientHeight: { value: 180 } });
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 180 }) as DOMRect;
  document.body.append(element);
  return element;
}
async function pump(until: () => boolean) {
  for (let i = 0; i < 250 && !until(); i++) {
    await stub.frame();
    for (let m = 0; m < 20; m++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(until()).toBe(true);
}
async function paint(action: () => unknown) {
  let done = false;
  let error: Error | undefined;
  const off = monitor.on('rendered', () => {
    done = true;
  });
  const fail = monitor.on('error', (value) => {
    error = value;
  });
  try {
    await action();
    await pump(() => done || !!error);
    if (error) throw error;
  } finally {
    off();
    fail();
  }
}
function source(elements: number, time: number[], reads: Window[] = []) {
  const events = createEmitter<{ append: undefined }>();
  const series: Series = {
    elementCount: elements,
    signalCount: 1,
    get state() {
      return {
        frameCount: time.length,
        timeRange: time.length ? ([time[0]!, time.at(-1)!] as const) : null,
        ranges: Float64Array.of(0, elements),
      };
    },
    on: (event, listener) => events.on(event, listener),
    async locate(range, head, signal) {
      signal?.throwIfAborted();
      let start = 0,
        end = 0;
      while (start < head && time[start]! < range[0]) start++;
      while (end < head && time[end]! <= range[1]) end++;
      return [start, end];
    },
    async read(_, window, signal) {
      signal?.throwIfAborted();
      reads.push(window);
      return {
        time: Float64Array.from(
          time.slice(window.frameOffset, window.frameOffset + window.frameCount),
        ),
        values: Float32Array.from(
          { length: window.frameCount * window.elementCount },
          (_, i) => window.elementOffset + (i % window.elementCount),
        ),
        stride: window.elementCount,
      };
    },
  };
  return { series, append: () => events.emit('append', undefined) };
}
/** A live series of one element and one signal, and reads that can be held or failed. */
function stream(initial: number[]) {
  const live = createSeries({ elementCount: 1, signalCount: 1 });
  const push = (values: number[]): void => {
    live.append({
      elementCount: 1,
      signalCount: 1,
      time: Float64Array.from(values, (_, i) => live.state.frameCount + i),
      values: Float64Array.from(values),
    });
  };
  push(initial);
  let gate: Promise<void> | null = null;
  const read = vi.fn<Series['read']>(async (...args) => {
    if (gate) await gate;
    return live.read(...args);
  });
  const series: Series = {
    ...live,
    get state() {
      return live.state;
    },
    read,
  };
  return {
    series,
    push,
    read,
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}
const historyTextures = () =>
  stub.log.textures.filter((texture) => texture.label === 'monitor-history');
function uploaded(label = 'monitor-values') {
  const write = stub.log.writes.filter((write) => write.label === label).at(-1)!;
  return new Float32Array(write.copy!.buffer);
}
const history = () => stub.log.draws.filter((draw) => draw.pipeline === 'monitor-history');
const focus = () => stub.log.draws.filter((draw) => draw.pipeline === 'monitor-focus');

it('tiles every element within the read budget and focuses only the selected trace', async () => {
  const reads: Window[] = [],
    elements = 150000;
  monitor.load(source(elements, [0, 0.03, 0.03, 0.2, 1], reads).series);
  await paint(() => monitor.attach(canvas()));
  expect(history().reduce((n, draw) => n + draw.instanceCount, 0)).toBe(elements * 4);
  expect(reads.some((window) => window.elementOffset > 32)).toBe(true);
  expect(
    Math.max(...reads.map((w) => w.frameCount * (w.elementCount + 1) * 8)),
  ).toBeLessThanOrEqual(1024 * 1024);
  const before = reads.length,
    draws = history().length;
  await paint(() => monitor.select(elements - 1));
  expect(
    reads.slice(before).every((w) => w.elementOffset === elements - 1 && w.elementCount === 1),
  ).toBe(true);
  expect(history()).toHaveLength(draws);
  expect(focus().reduce((n, draw) => n + draw.instanceCount, 0)).toBe(4);
});

it('reads a long focus independently of history blocks and before history finishes', async () => {
  const reads: Window[] = [],
    time = Array.from({ length: 100000 }, (_, i) => i);
  const input = source(150000, time, reads).series;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  monitor.load({
    ...input,
    async read(s, w, signal) {
      if (w.elementCount > 1) await blocked;
      return input.read(s, w, signal);
    },
  });
  await monitor.attach(canvas());
  monitor.select(149999);
  await pump(() => focus().reduce((n, d) => n + d.instanceCount, 0) === 99999);
  expect(reads.filter((w) => w.elementCount === 1)).toHaveLength(2);
  expect(history()).toHaveLength(0);
  monitor.destroy();
  release();
});

it('folds a long repaint to two rows per bucket of frames, and draws appends raw', async () => {
  const input = stream(Array.from({ length: 10000 }, (_, i) => i % 2));
  monitor.setOptions({ timeRange: [0, 20000], valueRange: [0, 1] });
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  // 10000 frames over 320 device pixels: buckets of 31 frames, 323 of them, each two rows.
  expect(history().reduce((n, d) => n + d.instanceCount, 0)).toBe(2 * 323 - 1);
  const upload = stub.log.writes.filter((write) => write.label === 'monitor-values').at(-1)!;
  expect(upload.byteLength).toBe(2 * 323 * 2 * 4);
  const values = new Float32Array(upload.source, upload.byteOffset, upload.byteLength / 4);
  // Each 31-frame bucket keeps both values in the order they came: the second starts on a 1.
  expect(Array.from({ length: 4 }, (_, row) => values[row * 2])).toEqual([0, 1, 1, 0]);

  await paint(() => input.push(Array.from({ length: 10 }, () => 0.5)));
  expect(history().reduce((n, d) => n + d.instanceCount, 0)).toBe(2 * 323 - 1 + 10);
});

it('keeps folded reads within budget even on a one-pixel canvas', async () => {
  const reads: Window[] = [];
  const time = Array.from({ length: 100000 }, (_, i) => i);
  monitor.setOptions({ valueRange: [0, 1] });
  monitor.load(source(1, time, reads).series);
  await paint(() => monitor.attach(canvas(1)));
  expect(reads.length).toBeGreaterThan(1);
  expect(
    reads.every((window) => window.frameCount * (window.elementCount + 1) * 8 <= 1024 * 1024),
  ).toBe(true);
  expect(reads.at(-1)!.frameOffset + reads.at(-1)!.frameCount).toBe(time.length);
});

it('carries each folded window last row into the next, so every join draws once', async () => {
  const reads: Window[] = [],
    elements = 2000;
  const time = Array.from({ length: 3200 }, (_, i) => i);
  monitor.setOptions({ valueRange: [0, elements] });
  monitor.load(source(elements, time, reads).series);
  await paint(() => monitor.attach(canvas()));
  // Buckets of 10 frames, several per read window, whole buckets only.
  expect(reads.every((window) => window.frameOffset % 10 === 0)).toBe(true);
  expect(history().reduce((n, d) => n + d.instanceCount, 0)).toBe(elements * (2 * 320 - 1));
  const axes = stub.log.writes
    .filter((write) => write.label === 'monitor-xnorm')
    .map((write) => new Float32Array(write.copy!.buffer));
  expect(axes.length).toBeGreaterThan(1);
  for (let i = 1; i < axes.length; i++) expect(axes[i]![0]).toBe(axes[i - 1]!.at(-1));
});

it('appends only the new segments with a stable mapping, without clearing history', async () => {
  const reads: Window[] = [],
    time = [0, 1, 2];
  const input = source(2, time, reads);
  monitor.setOptions({ timeRange: [0, 10], valueRange: [0, 2] });
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  const before = reads.length,
    clears = stub.log.clears.filter((t) => t === 'monitor-history').length;
  time.push(3, 4);
  await paint(input.append);
  expect(reads.slice(before)).toEqual([
    { frameOffset: 2, frameCount: 3, elementOffset: 0, elementCount: 2 },
  ]);
  expect(stub.log.clears.filter((t) => t === 'monitor-history')).toHaveLength(clears);
  expect(history().reduce((n, d) => n + d.instanceCount, 0)).toBe(8);
});

it('replays exact repeated times when automatic time mapping grows', async () => {
  const time = [0, 0.1, 0.1, 0.8],
    input = source(2, time);
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  time.push(1.7, 2);
  await paint(input.append);
  expect([...uploaded('monitor-xnorm')]).toEqual([
    0,
    Math.fround(0.05),
    Math.fround(0.05),
    Math.fround(0.4),
    Math.fround(0.85),
    1,
  ]);
});

it('ignores a locate that resolves after destroy even when the source ignores abort', async () => {
  const input = source(2, [0, 1]).series;
  let finish!: () => void,
    started = false;
  monitor.load({
    ...input,
    async locate(range, head) {
      started = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return input.locate(range, head);
    },
  });
  await monitor.attach(canvas());
  await pump(() => started);
  monitor.destroy();
  const submits = stub.log.submits,
    clears = stub.log.clears.length;
  finish();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await stub.frame();
  expect(stub.log.submits).toBe(submits);
  expect(stub.log.clears).toHaveLength(clears);
});

it('reports a read failure once and retries the same series cleanly', async () => {
  const input = source(2, [0, 1]).series;
  let fail = true;
  const original = {
    ...input,
    async read(s: number, w: Window, signal?: AbortSignal) {
      if (fail) throw new Error('read failed');
      return input.read(s, w, signal);
    },
  };
  const error = vi.fn();
  monitor.on('error', error);
  monitor.load(original);
  await monitor.attach(canvas());
  await pump(() => error.mock.calls.length > 0);
  expect(error).toHaveBeenCalledOnce();
  fail = false;
  await paint(() => monitor.load(original));
  expect(history().reduce((n, d) => n + d.instanceCount, 0)).toBe(2);
});

it('cancels pending reads on detach and replays on another canvas', async () => {
  const input = source(2, [0, 1]).series;
  let started = false,
    cancelled = false;
  monitor.load({
    ...input,
    read: (_s, _w, signal) =>
      new Promise((_, reject) => {
        started = true;
        signal!.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      }),
  });
  await monitor.attach(canvas());
  await pump(() => started);
  monitor.detach();
  expect(cancelled).toBe(true);
  monitor.load(input);
  await paint(() => monitor.attach(canvas()));
});

it('normalizes Float64 values before upload and maps color independently from height', async () => {
  const base = 1e12,
    delta = 0.125;
  const series = createSeries({
    elementCount: 2,
    signalCount: 1,
    time: Float64Array.of(0, 1),
    values: Float64Array.of(base, base + delta, base + delta / 2, NaN),
  });
  const range = vi.fn<(range: Domain) => void>();
  monitor.on('valueRange', range);
  monitor.load(series);
  const element = canvas();
  await paint(() => monitor.attach(element));
  const domain = range.mock.calls.at(-1)![0];
  expect(domain[0]).toBeLessThan(base);
  expect(domain[1]).toBeGreaterThan(base + delta);
  expect([...uploaded()]).toEqual(
    [base, base + delta, base + delta / 2, NaN].flatMap((value) => {
      const t = Math.fround(position(value, domain));
      return [t, t];
    }),
  );
  const picked = vi.fn();
  monitor.on('select', picked);
  element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }));
  await pump(() => picked.mock.calls.length > 0);
  expect(picked.mock.calls[0]![0].value).toBe(base + delta);
  await paint(() =>
    monitor.setOptions({
      valueRange: [base - delta, base + 2 * delta],
      colorRange: [base, base + delta],
    }),
  );
  expect(uploaded()[0]).toBeCloseTo(1 / 3);
  expect(uploaded()[1]).toBe(0);
  expect(uploaded()[2]).toBeCloseTo(2 / 3);
  expect(uploaded()[3]).toBe(1);
});

it('keeps extreme finite times and constant Float64 values visible', async () => {
  monitor.load(
    createSeries({
      elementCount: 1,
      signalCount: 1,
      time: Float64Array.of(-1e308, 0, 1e308),
      values: Float64Array.of(1e20, 1e20, 1e20),
    }),
  );
  await paint(() => monitor.attach(canvas()));
  expect([...uploaded('monitor-xnorm')]).toEqual([0, 0.5, 1]);
  expect([...uploaded()]).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
});

it('uses sparse class indices for selection and picking', async () => {
  monitor.load(
    createSeries({
      elementCount: 2,
      signalCount: 1,
      elements: Uint32Array.of(4, 900),
      time: Float64Array.of(0, 1),
      values: Float64Array.of(0, 1, 0, 1),
    }),
  );
  const element = canvas();
  await paint(() => monitor.attach(element));
  const picked = vi.fn();
  monitor.on('select', picked);
  element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }));
  await pump(() => picked.mock.calls.length > 0);
  expect(picked.mock.calls[0]![0].element).toBe(900);
  await paint(() => monitor.select(4));
  expect([...uploaded('monitor-focus-values')]).toEqual(Array(4).fill(Math.fround(1 / 12)));
});

it('does not let an obsolete hover clear the latest reading', async () => {
  const input = source(2, [0, 1, 2]).series;
  let delay = false;
  const pending: (() => void)[] = [];
  monitor.load({
    ...input,
    async locate(range, head) {
      if (delay) await new Promise<void>((resolve) => pending.push(resolve));
      return input.locate(range, head);
    },
  });
  const element = canvas();
  await paint(() => monitor.attach(element));
  delay = true;
  const hover = vi.fn();
  monitor.on('hover', hover);
  element.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 100 }));
  await pump(() => pending.length === 1);
  element.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 10 }));
  await pump(() => pending.length === 2);
  pending[1]!();
  await pump(() => hover.mock.calls.length === 1);
  expect(hover.mock.calls[0]![0]).toMatchObject({ frame: 1, element: 1 });
  pending[0]!();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(hover).toHaveBeenCalledOnce();
});

it('updates opacity without rereading or repainting history', async () => {
  const reads: Window[] = [];
  monitor.load(source(2, [0, 1], reads).series);
  await paint(() => monitor.attach(canvas()));
  await paint(() => monitor.select(1));
  const before = reads.length,
    draws = history().length;
  await paint(() => monitor.setOptions({ unselectedAlpha: 0.25 }));
  expect(reads).toHaveLength(before);
  expect(history()).toHaveLength(draws);
});

it('catches up an unknown range after switching back from a fixed domain', async () => {
  const reads: Window[] = [],
    time = [0, 1],
    input = source(2, time, reads);
  const series: Series = {
    ...input.series,
    get state() {
      return { ...input.series.state, ranges: null };
    },
    async read(s, w, signal) {
      const block = await input.series.read(s, w, signal);
      return {
        ...block,
        values: Float64Array.from(
          { length: w.frameCount * w.elementCount },
          (_, i) =>
            (w.frameOffset + Math.floor(i / w.elementCount)) * 10 +
            w.elementOffset +
            (i % w.elementCount),
        ),
      };
    },
  };
  const range = vi.fn();
  monitor.on('valueRange', range);
  monitor.setOptions({ valueRange: [0, 100] });
  monitor.load(series);
  await paint(() => monitor.attach(canvas()));
  time.push(2, 3);
  await paint(input.append);
  await paint(() => monitor.setOptions({ valueRange: null }));
  expect(range.mock.calls.at(-1)![0]).toEqual([-3.1, 34.1]);
});

it('validates live patches before changing the current mapping', async () => {
  monitor.load(source(2, [0, 1]).series);
  await paint(() => monitor.attach(canvas()));
  const before = history().length;
  for (const patch of [
    { colorRange: [2, 1] },
    { colorRange: [0, NaN] },
    { lineWidthPx: -1 },
  ] as Options[])
    expect(() => monitor.setOptions(patch)).toThrow();
  await stub.frame();
  expect(history()).toHaveLength(before);
});

it('draws appends inside the automatic range as a tail and repaints its growth off screen', async () => {
  const input = stream([0, 1]);
  const ranges = vi.fn<(range: Domain) => void>();
  monitor.on('valueRange', ranges);
  monitor.setOptions({ timeRange: [0, 100] });
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  expect(ranges.mock.calls.map(([range]) => range)).toEqual([[-0.1, 1.1]]);
  const clears = stub.log.clears.filter((target) => target === 'monitor-history').length;

  await paint(() => input.push([1.05]));
  expect(ranges).toHaveBeenCalledOnce();
  expect(stub.log.clears.filter((target) => target === 'monitor-history')).toHaveLength(clears);
  expect(history().at(-1)).toMatchObject({ instanceCount: 1 });
  expect(historyTextures()).toHaveLength(1);

  const release = input.hold();
  input.push([2]);
  await pump(() => ranges.mock.calls.length === 2);
  expect(ranges.mock.calls[1]![0]).toEqual([-0.2, 2.2]);
  const [shown, drawing] = historyTextures();
  expect(shown).toMatchObject({ destroyed: false });
  expect(drawing).toMatchObject({ destroyed: false });
  release();
  await pump(() => shown!.destroyed);
  expect(historyTextures().filter((texture) => !texture.destroyed)).toEqual([drawing]);
  expect(history().at(-1)).toMatchObject({ instanceCount: 3 });
});

it('grows the automatic range only from recorded values', async () => {
  const input = stream([NaN, NaN]);
  const ranges = vi.fn<(range: Domain) => void>();
  monitor.on('valueRange', ranges);
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  await paint(() => input.push([100, 200]));
  expect(ranges.mock.calls.map(([range]) => range)).toEqual([
    [0, 1],
    [90, 210],
  ]);
});

it('keeps the automatic range across a detach and attach', async () => {
  const input = stream([0, 1]);
  const ranges = vi.fn<(range: Domain) => void>();
  monitor.on('valueRange', ranges);
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  await paint(() => input.push([1.05]));
  monitor.detach();
  await paint(() => monitor.attach(canvas()));
  expect(ranges.mock.calls.map(([range]) => range)).toEqual([
    [-0.1, 1.1],
    [-0.1, 1.1],
  ]);
});

it('paints a newly loaded series in place of the last one', async () => {
  monitor.load(stream([0, 1]).series);
  await paint(() => monitor.attach(canvas()));
  const textures = historyTextures().length;
  await paint(() => monitor.load(stream([5, 6, 7]).series));
  expect(historyTextures()).toHaveLength(textures);
  expect(history().at(-1)).toMatchObject({ instanceCount: 2 });
});

it('retries a failed repaint once for an update queued meanwhile', async () => {
  const input = stream([0, 1]);
  const errors = vi.fn(),
    rendered = vi.fn();
  monitor.on('error', errors);
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  monitor.on('rendered', rendered);
  const [shown] = historyTextures();
  let reject: ((error: Error) => void) | null = null;
  input.read.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  input.push([2]);
  await pump(() => reject !== null);
  input.push([3]);
  reject!(new Error('read failed'));
  await pump(() => rendered.mock.calls.length > 0);
  expect(errors).toHaveBeenCalledOnce();
  expect(shown!.destroyed).toBe(true);
  expect(history().at(-1)).toMatchObject({ instanceCount: 3 });
});

it('stops after a failed retry until the next update', async () => {
  const input = stream([0, 1]);
  const errors = vi.fn();
  monitor.on('error', errors);
  monitor.load(input.series);
  await paint(() => monitor.attach(canvas()));
  const [shown] = historyTextures();
  let reject: ((error: Error) => void) | null = null;
  input.read.mockRejectedValue(new Error('still failing'));
  input.read.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  input.push([2]);
  await pump(() => reject !== null);
  input.push([3]);
  reject!(new Error('read failed'));
  await pump(() => errors.mock.calls.length === 2);
  const reads = input.read.mock.calls.length;
  for (let i = 0; i < 5; i++) await stub.frame();
  expect(input.read).toHaveBeenCalledTimes(reads);
  expect(shown!.destroyed).toBe(false);
});

it('reports hover once per sample under the pointer', async () => {
  monitor.load(source(2, [0, 1, 2]).series);
  const element = canvas();
  await paint(() => monitor.attach(element));
  const hover = vi.fn<(reading: Reading | null) => void>();
  monitor.on('hover', hover);
  element.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
  await pump(() => hover.mock.calls.length === 1);
  element.dispatchEvent(new MouseEvent('pointermove', { clientX: 12, clientY: 11 }));
  for (let i = 0; i < 3; i++) {
    await stub.frame();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  element.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 10 }));
  await pump(() => hover.mock.calls.length === 2);
  expect(hover.mock.calls.map(([reading]) => [reading!.element, reading!.frame])).toEqual([
    [1, 0],
    [1, 1],
  ]);
});
