import {
  type Data,
  type FieldInput,
  type ReadScope,
  type RowSelection,
  type SampleWindow,
} from '@latkit/model';
import { renderer as testRenderer } from '../../gpu/tests/fixtures/public-render.js';
import { describe, it, expect, vi } from 'vitest';
import { createGpu, kit, type Gpu } from '@latkit/gpu';
import { createMonitor, type Monitor, type MonitorConfig } from '../src/index.js';
import { SignalSource } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';
import { ticks } from '../src/ticks.js';

/** What a call throws. */
function failure(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
}
/** Drive the pointer as input does. */
const pointer = (monitor: Monitor, point: readonly [number, number] | null) =>
  (monitor as unknown as { pointer(point: readonly [number, number] | null): void }).pointer(point);
type History = Record<string, { progress: Map<string, { through?: number }> } | undefined>;
/** The last frame each image of the presented, or exported, history holds for a trace. */
const through = (
  monitor: Monitor,
  image: 'front' | 'back' = 'front',
  history: 'presentedHistory' | 'exportedHistory' = 'presentedHistory',
) =>
  (monitor as unknown as Record<string, History | undefined>)[history]?.[image]?.progress.get(
    'signal',
  )?.through;
/** One read the monitor asked of a scope. */
interface Request {
  readonly kind: string;
  readonly source: Data;
  readonly rows?: RowSelection;
  readonly select?: readonly string[];
  readonly fields?: Readonly<Record<string, FieldInput>>;
  readonly window?: SampleWindow;
}
const fieldNames = (fields: Readonly<Record<string, FieldInput>>) =>
  Object.values(fields).flatMap((input) =>
    typeof input === 'string' ? [input] : 'field' in input ? [input.field] : [],
  );
/** Record every read the monitor makes through the Gpu's reader. */
function record(gpu: Gpu, requests: Request[]) {
  const open = gpu.reader.open.bind(gpu.reader);
  vi.spyOn(gpu.reader, 'open').mockImplementation((options) => {
    const scope = open(options);
    const recorded: ReadScope = {
      get signal() {
        return scope.signal;
      },
      at: scope.at,
      get busy() {
        return scope.busy;
      },
      read(source, query) {
        requests.push({ source, ...query });
        return scope.read(source, query);
      },
      fields(request) {
        requests.push({ ...request, kind: 'fields', select: fieldNames(request.fields) });
        return scope.fields(request);
      },
      extent(request) {
        requests.push({ ...request, kind: 'extent' });
        return scope.extent(request);
      },
      close: () => scope.close(),
    };
    return recorded;
  });
}
/** Frames reads the monitor made for history, as [first, end). */
const drawn = (requests: readonly Request[]) =>
  requests.flatMap((q) =>
    q.kind === 'fields' && q.window?.kind === 'frames'
      ? [[q.window.offset, q.window.offset + q.window.count] as const]
      : [],
  );
async function harness(source = new SignalSource(4, 128), options: Partial<MonitorConfig> = {}) {
  const fake = fakeDevice();
  const encoder = fake.native.createCommandEncoder.getMockImplementation()!;
  fake.native.createCommandEncoder.mockImplementation(() =>
    Object.assign(encoder(), {
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    }),
  );
  Object.assign(fake.native, { createPipelineLayout: () => ({}) });
  const gpu = await createGpu({ device: fake.device, validate: true });
  const target = kit.createTextureTarget(gpu, { width: 512, height: 256 });
  const monitor = createMonitor(gpu, {
    source: source.data,
    traces: { signal: { from: 'signal', field: 'value' } },
    camera: {
      window: [source.coordinate(source.before), source.coordinate(source.frames + 127)],
      values: [(source.options.valueOrigin ?? 0) - 2, (source.options.valueOrigin ?? 0) + 2],
    },
    coordinateAxis: false,
    valueAxis: false,
    ...options,
  });
  const requests: Request[] = [];
  record(gpu, requests);
  const renderer = kit.rendererOf(monitor);
  const render = (complete = true, at?: number) =>
    gpu.render({
      views: [{ renderer, target, at }],
      timeMs: performance.now(),
      ...(complete ? { completion: 'complete' as const } : {}),
    });
  /** The canvas point of a reading under the latest camera; the plot spans 12 to 500 by 12 to 244. */
  const point = (frame: number, row = 0) => {
    const { window, values } = monitor.camera;
    return [
      12 + ((source.coordinate(frame) - window[0]) / (window[1] - window[0])) * 488,
      12 + ((values[1] - source.value(row, frame)) / (values[1] - values[0])) * 232,
    ] as const;
  };
  return {
    fake,
    requests,
    gpu,
    target,
    monitor,
    renderer,
    render,
    source,
    point,
    close() {
      monitor.destroy();
      target.destroy();
      gpu.destroy();
    },
  };
}

describe('history', () => {
  it('draws history once and never reads it again for a playhead', async () => {
    const h = await harness();
    await h.render();
    expect(h.monitor.stats()).toMatchObject({ rows: 4, visible: true, refining: false });
    expect(h.renderer.pending).toBeUndefined();
    const reads = h.gpu.stats().queries,
      uploads = h.gpu.stats().uploadedBytes;
    for (let i = 0; i < 6; i++) await h.render(true, i);
    expect(h.gpu.stats().queries).toBe(reads);
    expect(h.gpu.stats().uploadedBytes - uploads).toBeLessThan(8192);
    h.close();
  });
  it('exports into its own history, leaving the presented images and picking as they were', async () => {
    const h = await harness();
    await h.render();
    const [hit] = await h.monitor.pick(h.point(64), { radiusPx: 1, limit: 1 });
    const front = (h.monitor as unknown as Record<string, { front?: object }>).presentedHistory
      .front;
    const exported = kit.createTextureTarget(h.gpu, { width: 256, height: 512 });
    await h.gpu.render({
      views: [{ renderer: h.renderer, target: exported, presented: false }],
      timeMs: performance.now(),
      completion: 'complete',
    });
    // The export drew everything at its own size, and the canvas's history is untouched.
    expect(through(h.monitor, 'front', 'exportedHistory')).toBe(h.source.firstFrame + 127);
    expect(
      (h.monitor as unknown as Record<string, { front?: object }>).presentedHistory.front,
    ).toBe(front);
    expect(await h.monitor.pick(h.point(64), { radiusPx: 1, limit: 1 })).toEqual([hit]);
    expect(h.monitor.stats().refining).toBe(false);
    // Presenting again lets the export's history go.
    await h.render();
    expect(through(h.monitor, 'front', 'exportedHistory')).toBeUndefined();
    exported.destroy();
    h.close();
  });
  it('appends draw only the new frames, joined to the last frame drawn', async () => {
    const h = await harness();
    await h.render();
    const last = through(h.monitor)!;
    expect(last).toBe(h.source.firstFrame + 127);
    h.requests.length = 0;
    h.source.append(8);
    h.monitor.set({ source: h.source.data });
    await h.render();
    const reads = drawn(h.requests);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(([first]) => first >= last)).toBe(true);
    expect(through(h.monitor)).toBe(h.source.firstFrame + 135);
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('draws every frame streamed into a fixed window at epoch coordinates', async () => {
    const source = new SignalSource(16, 1, { coordinateOrigin: 1.7e9, step: 0.1 });
    const h = await harness(source, {
      camera: { window: [1.7e9, 1.7e9 + 60], values: [-2, 2] },
    });
    await h.render();
    for (let i = 0; i < 300; i++) {
      source.append(1);
      h.monitor.set({ source: source.data });
      await h.render(false);
    }
    await h.render();
    expect(through(h.monitor)).toBe(source.firstFrame + 300);
    expect(h.monitor.stats().refining).toBe(false);
    const [hit] = await h.monitor.pick(h.point(300), { radiusPx: 1, limit: 1 });
    expect(hit).toMatchObject({ row: 0, frame: source.firstFrame + 300 });
    h.close();
  });
  it('streams into a monitor created before any samples arrive', async () => {
    const source = new SignalSource(8, 0);
    const h = await harness(source, { camera: { window: [0, 4] } });
    await h.render();
    expect(h.monitor.stats().refining).toBe(false);
    for (let i = 0; i < 200; i++) {
      source.append(1);
      h.monitor.set({ source: source.data });
      await h.render(false);
      expect(through(h.monitor)).toBe(source.firstFrame + i);
    }
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('keeps drawing arrivals into the shown image while a replacement draws behind it', async () => {
    const h = await harness(new SignalSource(64, 4096), { limits: { segmentsPerFrame: 4096 } });
    await h.render();
    h.monitor.set({ camera: { window: [h.source.coordinate(0), h.source.coordinate(5000)] } });
    await h.render(false);
    expect(through(h.monitor, 'back')).toBeLessThan(h.source.firstFrame + 4095);
    h.source.append(4);
    h.monitor.set({ source: h.source.data });
    await h.render(false);
    expect(through(h.monitor)).toBe(h.source.firstFrame + 4099);
    await h.render();
    expect(through(h.monitor)).toBe(h.source.firstFrame + 4099);
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('pauses a chunk between row blocks and finishes it without drawing a line twice', async () => {
    const h = await harness(new SignalSource(160, 128), { limits: { segmentsPerFrame: 100 } });
    const seen = new Map<string, number>();
    for (let i = 0; i < 400 && h.monitor.stats().refining !== false; i++) {
      await h.render(false);
      for (const [first, end] of drawn(h.requests.splice(0)))
        seen.set(first + ':' + end, (seen.get(first + ':' + end) ?? 0) + 1);
    }
    expect(h.monitor.stats().refining).toBe(false);
    expect(through(h.monitor)).toBe(h.source.firstFrame + 127);
    expect([...seen.keys()].length).toBeGreaterThan(1);
    h.close();
  });
  it('replaces a resized image only once resizing pauses, reusing uploads', async () => {
    const h = await harness();
    await h.render();
    const reads = h.gpu.stats().queries;
    h.target.resize({ width: 600, height: 300 });
    await h.render(false);
    expect(h.gpu.stats().queries).toBe(reads);
    await new Promise((resolve) => setTimeout(resolve, 130));
    await h.render();
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('keeps explicit data bindings when the default source receives more samples', async () => {
    const source = new SignalSource(2, 128),
      original = source.data;
    const h = await harness(source, {
      traces: {
        signal: { from: 'signal', field: { source: original, from: 'signal', field: 'value' } },
      },
    });
    await h.render();
    const last = through(h.monitor);
    source.append(8);
    h.monitor.set({ source: source.data });
    await h.render();
    expect(through(h.monitor)).toBe(last);
    h.close();
  });
  it('fails explicitly when rows exceed the configured capacity', async () => {
    const h = await harness();
    h.monitor.destroy();
    const view = createMonitor(h.gpu, {
      source: h.source.data,
      traces: { a: { from: 'signal', field: 'value' } },
      camera: { window: [0, 2], values: [-2, 2] },
      limits: { rows: 1 },
      coordinateAxis: false,
      valueAxis: false,
    });
    await expect(
      h.gpu.render({
        timeMs: 0,
        views: [{ renderer: kit.rendererOf(view), target: h.target }],
        completion: 'complete',
      }),
    ).rejects.toMatchObject({ code: 'resource-limit' });
    view.destroy();
    h.close();
  });
  it('marks frames drawn only when their frame is submitted', async () => {
    const h = await harness(new SignalSource(16, 512));
    const broken = testRenderer(() => {
      throw new Error('cancel frame');
    });
    await expect(
      h.gpu.render({
        timeMs: 0,
        views: [
          { renderer: h.renderer, target: h.target },
          { renderer: broken, target: h.target },
        ],
      }),
    ).rejects.toThrow('cancel frame');
    expect(through(h.monitor)).toBeUndefined();
    await h.render();
    expect(through(h.monitor)).toBe(h.source.firstFrame + 511);
    expect(h.monitor.stats().rows).toBe(16);
    h.close();
  });
  it('does not submit partial work when another renderer fails', async () => {
    const h = await harness();
    await h.render();
    const n = h.fake.queue.submit.mock.calls.length;
    const broken = testRenderer(() => {
      throw new Error('other renderer');
    });
    await expect(
      h.gpu.render({
        timeMs: 0,
        views: [
          { renderer: h.renderer, target: h.target },
          { renderer: broken, target: h.target },
        ],
      }),
    ).rejects.toThrow('other renderer');
    expect(h.fake.queue.submit.mock.calls.length).toBe(n);
    h.close();
  });
  it('does not redraw shaded history on pointer movement', async () => {
    const h = await harness(undefined, { hover: 'off' });
    await h.render();
    h.monitor.set({ shade: { wgsl: 'fn shade(f:ShadeFragment)->vec4f { return f.color; }' } });
    await h.render();
    await new Promise((r) => setTimeout(r, 0));
    await h.render();
    const reads = h.gpu.stats().queries,
      uploads = h.gpu.stats().uploadedBytes;
    for (let i = 0; i < 8; i++) {
      pointer(h.monitor, [200 + i, 100]);
      await h.render(false);
    }
    expect(h.gpu.stats().queries).toBe(reads);
    expect(h.renderer.pending).toBeUndefined();
    expect(h.gpu.stats().uploadedBytes - uploads).toBeLessThan(8192);
    h.close();
  });
  it('keeps application observations usable after destroying a monitor', async () => {
    const source = new SignalSource(2, 32),
      value = source.data,
      h = await harness(source);
    await h.render();
    h.close();
    expect(source.data).toBe(value);
    expect(value.tables.signal.fields.value.at(0)!.column.length).toBe(64);
  });
});

describe('fitted values', () => {
  it('fit the window as frames append, and grow without rereading history', async () => {
    const source = new SignalSource(4, 64);
    const h = await harness(source, { camera: { window: [0, 2] } });
    await h.render();
    const fitted = h.monitor.camera.values;
    let lo = Infinity,
      hi = -Infinity;
    for (let r = 0; r < 4; r++)
      for (let f = 0; f < 64; f++) {
        const v = source.value(r, f);
        if (source.valid(r, f)) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
      }
    expect(fitted[0]).toBeLessThan(lo);
    expect(fitted[1]).toBeGreaterThan(hi);
    h.requests.length = 0;
    source.append(64);
    h.monitor.set({ source: source.data });
    await h.render();
    expect(h.requests.filter((q) => q.kind === 'extent' || q.kind === 'aggregate')).toEqual([]);
    expect(h.monitor.camera.fit).toBe(true);
    h.close();
  });
  it('fits the window to every recorded coordinate of every trace', async () => {
    const source = new SignalSource(2, 64, { coordinateOrigin: 3 }),
      longer = new SignalSource(2, 96, { coordinateOrigin: 3 });
    const h = await harness(source, {
      traces: {
        signal: { from: 'signal', field: 'value' },
        longer: { from: 'signal', field: { source: longer.data, from: 'signal', field: 'value' } },
      },
      camera: { window: [0, 1], values: [-2, 2] },
    });
    await h.render();
    h.monitor.fit();
    expect(h.monitor.camera).toMatchObject({
      window: [source.coordinate(0), longer.coordinate(95)],
      fit: true,
    });
    await h.render();
    expect(h.monitor.stats().visible).toBe(true);
    h.close();
  });
});

describe('inspection', () => {
  it('picks exact Float64 readings and focuses only the selected row', async () => {
    const source = new SignalSource(3, 32, {
      coordinateOrigin: 2 ** 40,
      valueOrigin: 2 ** 40,
      step: 0.125,
    });
    const h = await harness(source);
    await h.render();
    const hits = await h.monitor.pick(h.point(10, 1), { radiusPx: 0.5, limit: 4 });
    const hit = hits.find((item) => item.row === 1)!;
    expect(hit).toMatchObject({
      frame: source.firstFrame + 10,
      value: source.value(1, 10),
      coordinate: source.coordinate(10),
      source: h.source.data,
    });
    h.requests.length = 0;
    h.monitor.select([hit]);
    await h.render();
    const focused = h.requests.filter((q) => q.kind === 'fields');
    expect(focused.length).toBeGreaterThan(0);
    expect(
      focused.every((q) => q.rows?.kind === 'range' && q.rows.offset === 1 && q.rows.count === 1),
    ).toBe(true);
    h.close();
  });
  it('reports exact hover a frame later and reuses it while the pointer rests', async () => {
    const h = await harness(undefined, { hover: 'on', pickRadiusPx: 200 });
    const hovered = vi.fn();
    h.monitor.on('hover', hovered);
    await h.render();
    pointer(h.monitor, [256, 128]);
    await h.render();
    await new Promise((r) => setTimeout(r, 10));
    expect(hovered).toHaveBeenCalledTimes(1);
    expect(hovered).toHaveBeenCalledWith(expect.objectContaining({ trace: 'signal' }));
    const reads = h.gpu.stats().queries;
    await h.render(false);
    await h.render(false);
    expect(h.gpu.stats().queries).toBe(reads);
    expect(h.monitor.stats().hover).toBe('active');
    pointer(h.monitor, null);
    await Promise.resolve();
    expect(hovered).toHaveBeenLastCalledWith(null);
    h.close();
  });
  it('reuses exact inspection at the same pointer without another query', async () => {
    const h = await harness();
    await h.render();
    const point = [256, 128] as const;
    const first = await h.monitor.pick(point, { limit: 1 });
    const reads = h.gpu.stats().queries;
    expect(await h.monitor.pick(point, { limit: 1 })).toEqual(first);
    expect(h.gpu.stats().queries).toBe(reads);
    h.close();
  });
  it('reports camera changes, focuses several rows, and locates readings', async () => {
    const h = await harness();
    const cameras = vi.fn();
    h.monitor.on('camera', cameras);
    await h.render();
    expect(cameras).toHaveBeenCalledTimes(1);
    const [hit] = await h.monitor.pick([256, 128], { radiusPx: 300, limit: 1 });
    const point = h.monitor.locate(hit)!;
    expect(point[0]).toBeCloseTo(hit.point[0], 3);
    expect(point[1]).toBeCloseTo(hit.point[1], 3);
    const row = (row: number) => ({ source: h.source.data, index: h.source.index, row });
    h.requests.length = 0;
    h.monitor.select([row(2), row(0)]);
    await h.render();
    const focused = h.requests.filter((q) => q.kind === 'fields');
    expect(focused.length).toBeGreaterThan(0);
    expect(
      focused.every((q) => q.rows?.kind === 'indices' && [...q.rows.values].join() === '0,2'),
    ).toBe(true);
    h.monitor.set({ camera: { window: [1, 2] } });
    expect(h.monitor.camera).toMatchObject({ window: [1, 2], fit: false });
    await h.render();
    expect(cameras).toHaveBeenLastCalledWith(expect.objectContaining({ window: [1, 2] }));
    h.close();
  });
  it('keeps selected rows through appends and prunes them with their row space', async () => {
    const source = new SignalSource(3, 32);
    const h = await harness(source);
    const selected = vi.fn();
    h.monitor.on('select', selected);
    await h.render();
    const row = { source: source.data, index: source.index, row: 1 };
    expect(
      failure(() =>
        h.monitor.select([{ ...row, index: { ...source.index, source: 'elsewhere' } }]),
      ),
    ).toMatchObject({ code: 'conflict' });
    h.monitor.select([row]);
    await h.render();
    source.append(4);
    h.monitor.set({ source: source.data });
    await h.render();
    expect(h.monitor.selection).toEqual([row]);
    const replaced = Object.assign(new SignalSource(3, 32), {
      index: { source: 'replacement', type: 'signal', version: 'rows0' },
    });
    h.monitor.set({ source: replaced.data });
    await h.render();
    await Promise.resolve();
    expect(h.monitor.selection).toEqual([]);
    expect(selected).toHaveBeenCalledExactlyOnceWith([]);
    h.close();
  });
  it('frames readings once and reveals one outside the window', async () => {
    const h = await harness();
    await h.render();
    const [hit] = await h.monitor.pick([256, 128], { radiusPx: 300, limit: 1 });
    h.monitor.fit([hit]);
    await h.render();
    const framed = h.monitor.camera;
    expect(framed.fit).toBe(false);
    expect((framed.window[0] + framed.window[1]) / 2).toBeCloseTo(hit.coordinate, 9);
    expect(framed.values[0]).toBeLessThan(hit.value);
    expect(framed.values[1]).toBeGreaterThan(hit.value);
    h.monitor.set({ camera: { window: [10, 11], values: [-2, 2] } });
    await h.render();
    expect(h.monitor.locate(hit)![0]).toBeLessThan(0);
    h.monitor.reveal(hit);
    const shown = h.monitor.camera;
    expect((shown.window[0] + shown.window[1]) / 2).toBeCloseTo(hit.coordinate, 9);
    expect(shown.window[1] - shown.window[0]).toBeCloseTo(1, 9);
    h.close();
  });
  it('drops selected readings whose trace is no longer drawn', async () => {
    const h = await harness(undefined, {
      traces: {
        signal: { from: 'signal', field: 'value' },
        other: { from: 'signal', field: 'other' },
      },
    });
    const selected = vi.fn();
    h.monitor.on('select', selected);
    await h.render();
    const [hit] = await h.monitor.pick([256, 128], { radiusPx: 300, limit: 1 });
    const row = { source: h.source.data, index: h.source.index, row: 2, trace: 'other' };
    h.monitor.select([hit, row]);
    h.monitor.set({ traces: { [hit.trace]: null } });
    await h.render();
    await Promise.resolve();
    expect(h.monitor.selection).toEqual(hit.trace === 'other' ? [] : [row]);
    expect(selected).toHaveBeenCalledOnce();
    h.close();
  });
});

it('rejects unknown options and limits, and invalid cameras', async () => {
  const h = await harness();
  expect(() => h.monitor.set({ limits: { frameMs: 3 } as never })).toThrow('Unknown monitor limit');
  expect(() => h.monitor.set({ detail: 'full' } as never)).toThrow('Unknown monitor option');
  h.monitor.set({ selectedColor: [0, 1, 0, 1], limits: { segmentsPerFrame: 9 } });
  expect(failure(() => h.monitor.set({ camera: { window: [2, 1] } }))).toMatchObject({
    code: 'invalid-input',
  });
  expect(failure(() => h.monitor.set({ camera: { follow: 1 } as never }))).toMatchObject({
    code: 'invalid-input',
  });
  await h.render();
  expect(h.monitor.stats()).toMatchObject({ rows: 4, visible: true, refining: false });
  h.close();
});
it('formats fractional and large-offset ticks without duplicate labels', () => {
  const small = ticks([0, 0.1], 320, {});
  expect(new Set(small.items.map((t) => t.label)).size).toBe(small.items.length);
  expect(small.items.some((t) => t.label === '0.025')).toBe(true);
  const large = ticks([2 ** 40, 2 ** 40 + 1], 640, {});
  expect(large.offset).toBe(2 ** 40);
  expect(large.items.length).toBeGreaterThan(2);
});
