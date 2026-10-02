import { Tiles } from '../src/tiles.js';
import { appendData } from '@latkit/model';
import { renderer as testRenderer } from '../../gpu/tests/fixtures/public-render.js';
import { describe, it, expect, vi } from 'vitest';
import { createGpu, kit } from '@latkit/gpu';
import { createMonitor, type Monitor, type MonitorConfig } from '../src/index.js';
import { SignalSource } from './fixture.js';
import { deferred, fakeDevice } from '../../gpu/tests/fixtures/device.js';
import { ticks } from '../src/ticks.js';
import { Seams } from '../src/segments.js';
import { describeBindings } from '../src/bindings.js';
import { history, isEnvelope } from '../src/history.js';
import { limits } from '../src/config.js';
/** The canvas coordinate and value under a point, from the presented axes. */
const toData = (monitor: Monitor, point: readonly [number, number]) =>
  (
    monitor as unknown as {
      toData(point: readonly [number, number]): { coordinate: number; value: number } | null;
    }
  ).toData(point);
/** Drive the pointer as input does. */
const pointer = (monitor: Monitor, point: readonly [number, number] | null) =>
  (monitor as unknown as { point(point: readonly [number, number] | null): void }).point(point);
async function harness(source = new SignalSource(4, 128), options: Partial<MonitorConfig> = {}) {
  const fake = fakeDevice();
  Object.assign(fake.native, {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({}),
    pushErrorScope() {},
    async popErrorScope() {
      return null;
    },
  });
  const encoder = fake.native.createCommandEncoder.getMockImplementation()!;
  fake.native.createCommandEncoder.mockImplementation(() =>
    Object.assign(encoder(), {
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    }),
  );
  const gpu = await createGpu({ device: fake.device, validate: true });
  const target = kit.createRenderTarget({ gpu, width: 512, height: 256 });
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
  const rawQuery = gpu.query.bind(gpu);
  const requests = vi.spyOn(gpu, 'query');
  const renderer = kit.rendererOf(monitor);
  const render = (complete = true, at?: number) =>
    gpu.render({
      views: [{ renderer, target, at }],
      timeMs: 10,
      ...(complete ? { completion: 'complete' as const } : {}),
    });
  return {
    fake,
    rawQuery,
    requests,
    gpu,
    target,
    monitor,
    renderer,
    render,
    source,
    close() {
      monitor.destroy();
      target.destroy();
      gpu.destroy();
    },
  };
}
describe('bounded monitor lifecycle', () => {
  it('drains native history, reuses images and never re-queries for a playhead', async () => {
    const h = await harness();
    await h.render();
    expect(h.monitor.stats().traces).toBe(4);
    expect(h.renderer.pending).toBeUndefined();
    const reads = h.gpu.stats().queries,
      uploads = h.gpu.stats().uploadedBytes;
    for (let i = 0; i < 6; i++) await h.render(true, i);
    expect(h.gpu.stats().queries).toBe(reads);
    expect(h.gpu.stats().uploadedBytes - uploads).toBeLessThan(8192);
    h.close();
    expect(h.renderer.pending).toBeUndefined();
  });
  it('resizes the committed image without reads until resizing settles', async () => {
    const h = await harness();
    await h.render();
    const reads = h.gpu.stats().queries;
    h.target.resize({ width: 600, height: 300 });
    await h.render(false);
    expect(h.gpu.stats().queries).toBe(reads);
    await h.render();
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('appends only new frames and keeps the fixed-domain history', async () => {
    const h = await harness();
    await h.render();
    const first = h.requests.mock.calls.map((call) => call[1]).length;
    h.source.append(8);
    h.monitor.set({ source: h.source.data });
    await h.render();
    const queries = h.requests.mock.calls
      .map((call) => call[1])
      .slice(first)
      .filter((q) => q.kind === 'samples' && q.window.kind !== 'at');
    expect(queries.length).toBeGreaterThan(0);
    expect(
      queries.every(
        (q) =>
          q.kind === 'samples' &&
          q.window.kind === 'frames' &&
          q.window.offset === h.source.firstFrame + 128 &&
          q.window.count <= 8,
      ),
    ).toBe(true);
    h.close();
  });
  it('keeps explicit data bindings fixed when the default source receives more samples', async () => {
    const source = new SignalSource(2, 128),
      original = source.data;
    const h = await harness(source, {
      traces: {
        signal: { from: 'signal', field: { source: original, from: 'signal', field: 'value' } },
      },
    });
    await h.render();
    source.append(8);
    h.monitor.set({ source: source.data });
    h.requests.mockClear();
    await h.render();
    const reads = h.requests.mock.calls.filter((call) => call[1].kind === 'samples');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call[0] === original)).toBe(true);
    h.close();
  });
  it('focuses only the selected native row and returns exact Float64 identities', async () => {
    const source = new SignalSource(3, 32, {
      coordinateOrigin: 2 ** 40,
      valueOrigin: 2 ** 40,
      step: 0.125,
    });
    const h = await harness(source);
    await h.render();
    const value = source.value(1, 10),
      coordinate = source.coordinate(10),
      point = [
        12 +
          ((coordinate - source.coordinate(0)) /
            (source.coordinate(source.frames + 127) - source.coordinate(0))) *
            488,
        12 + (((source.options.valueOrigin ?? 0) + 2 - value) / 4) * 232,
      ] as const;
    const hits = await h.monitor.pick(point, { radiusPx: 0.1, limit: 4 });
    expect(
      hits.some(
        (hit) =>
          hit.row === 1 &&
          hit.frame === source.firstFrame + 10 &&
          hit.value === value &&
          hit.coordinate === coordinate &&
          hit.version === source.version,
      ),
    ).toBe(true);
    const first = h.requests.mock.calls.map((call) => call[1]).length;
    h.monitor.select([hits.find((hit) => hit.row === 1)!]);
    await h.render();
    expect(
      h.requests.mock.calls
        .map((call) => call[1])
        .slice(first)
        .filter((q) => q.kind === 'samples')
        .every((q) => q.rows?.kind === 'range' && q.rows.offset === 1 && q.rows.count === 1),
    ).toBe(true);
    h.close();
  });
  it('updates follow after queued appends', async () => {
    const source = new SignalSource(3, 128);
    const h = await harness(source, {
      camera: {
        window: [source.coordinate(source.before), source.coordinate(source.frames + 127)],
        values: [-2, 2],
        follow: 0.5,
      },
    });
    await h.render();
    h.source.append(8);
    h.monitor.set({ source: h.source.data });
    await h.render();
    expect(toData(h.monitor, [256, 128])!.coordinate).toBeCloseTo(h.source.coordinate(135) - 0.25);
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('cancels a pending progressive generation and releases its iterator', async () => {
    const h = await harness(new SignalSource(128, 4096));
    await h.render(false);
    h.monitor.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.renderer.pending).toBeUndefined();
    expect(h.renderer.pending).toBeUndefined();
    h.target.destroy();
    h.gpu.destroy();
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
  it('coalesces an append arriving during progressive preparation', async () => {
    const h = await harness(new SignalSource(16, 1024));
    await h.render(false);
    h.source.append(8);
    h.monitor.set({ source: h.source.data });
    await h.render();
    expect(h.renderer.pending).toBeUndefined();
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
});
it('refines gapped envelope rectangles as native samples', async () => {
  const h = await harness(new SignalSource(2, 1024, { native: true, gaps: true }));
  const data = {
    source: h.source.data,
    window: { kind: 'range' as const, between: [0, 10] as const },
    traces: { a: { from: 'signal', field: 'value' } },
  };
  const bindings = await describeBindings(h.gpu, data, new AbortController().signal);
  let raw = 0;
  for await (const block of history({
    gpu: h.gpu,
    data,
    bindings,
    window: data.window,
    pixels: 16,
    detail: 'auto',
    limits: limits(),
    signal: new AbortController().signal,
  })) {
    if (!isEnvelope(block.data)) raw++;
  }
  expect(raw).toBeGreaterThan(0);
  h.close();
});
it('preserves source order when joining reversed native tiles', () => {
  const seams = new Seams(1e6);
  const point = (frame: number) => ({
    frame,
    coordinate: frame,
    value: frame,
    color: NaN,
    shade: 0,
    visible: true,
  });
  expect(seams.connect('a', point(20), point(29), 20, 29)).toEqual([]);
  expect(seams.connect('a', point(10), point(19), 10, 19)).toEqual([[point(19), point(20)]]);
  expect(seams.tails.get('a')?.frame).toBe(29);
});
it('formats fractional and large-offset ticks without duplicate labels', () => {
  const small = ticks([0, 0.1], 320, {});
  expect(new Set(small.items.map((t) => t.label)).size).toBe(small.items.length);
  expect(small.items.some((t) => t.label === '0.025')).toBe(true);
  const large = ticks([2 ** 40, 2 ** 40 + 1], 640, {});
  expect(large.offset).toBe(2 ** 40);
  expect(large.items.length).toBeGreaterThan(2);
});

it('suspends automatic hover when refinement exceeds its soft budget', async () => {
  const h = await harness(new SignalSource(256, 128), { hover: 'auto', hoverBudgetMs: 0.000001 });
  await h.render();
  pointer(h.monitor, [256, 128]);
  await new Promise((r) => setTimeout(r, 80));
  expect(h.monitor.stats().hover).toBe('budget');
  const reads = h.gpu.stats().queries;
  pointer(h.monitor, [258, 128]);
  await new Promise((r) => setTimeout(r, 60));
  expect(h.gpu.stats().queries).toBe(reads);
  h.monitor.set({ hover: 'off' });
  expect(h.monitor.stats().hover).toBe('off');
  h.close();
});

it('keeps committed domains during replacement and supersedes unfinished windows', async () => {
  const h = await harness(new SignalSource(32, 4096));
  await h.render();
  const before = toData(h.monitor, [256, 128]);
  h.monitor.set({ camera: { window: [1, 2] } });
  await h.render(false);
  expect(toData(h.monitor, [256, 128])).toEqual(before);
  h.monitor.set({ camera: { window: [2, 4] } });
  await h.render();
  expect(toData(h.monitor, [256, 128])!.coordinate).toBe(3);
  expect(h.renderer.pending).toBeUndefined();
  h.close();
});
it('does not invalidate its own preparation while resizing', async () => {
  const h = await harness();
  await h.render();
  const events: string[] = [];
  h.renderer.on!('invalidate', () => {
    events.push('refresh');
  });
  h.target.resize({ width: 600, height: 300 });
  await h.render(false);
  expect(events).not.toContain('replace');
  await h.render();
  h.close();
});

it('does not replay shaded history on pointer movement', async () => {
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

it('publishes initial data before draining the bounded producer', async () => {
  const h = await harness(new SignalSource(256, 4096, { blockFrames: 32 }));
  for (let i = 0; i < 20 && !h.monitor.stats().visible; i++) {
    await h.render(false);
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(h.monitor.stats().visible).toBe(true);
  expect(h.renderer.pending).toBeDefined();
  expect(h.monitor.stats().pendingBytes).toBeLessThanOrEqual(16 * 1024 ** 2);
  h.close();
  await new Promise((r) => setTimeout(r, 10));
  expect(h.renderer.pending).toBeUndefined();
});
it('makes progress during continuous appends without restarting history', async () => {
  const h = await harness(new SignalSource(32, 512, { blockFrames: 16 }));
  const invalidations: undefined[] = [];
  h.renderer.on!('invalidate', () => invalidations.push(undefined));
  await h.render(false);
  for (let i = 0; i < 30; i++) {
    h.source.append(1);
    h.monitor.set({ source: h.source.data });
    await new Promise((r) => setTimeout(r, 2));
    await h.render(false);
  }
  expect(h.monitor.stats().visible).toBe(true);
  expect(invalidations.length).toBeGreaterThan(0);
  await h.render();
  expect(h.renderer.pending).toBeUndefined();
  const count = h.requests.mock.calls
    .map((call) => call[1])
    .filter((q) => q.kind === 'samples' && q.window.kind === 'range').length;
  expect(count).toBeLessThan(20);
  h.close();
});
it('accepts single observations after an initially empty source', async () => {
  const h = await harness(new SignalSource(1, 0));
  await h.render();
  for (let i = 0; i < 4; i++) {
    h.source.append(1);
    h.monitor.set({ source: h.source.data });
    await h.render();
  }
  const coordinate = h.source.coordinate(3),
    value = h.source.value(0, 3);
  const hits = await h.monitor.pick(
    [12 + (coordinate / h.source.coordinate(127)) * 488, 12 + ((2 - value) / 4) * 232],
    { radiusPx: 1, limit: 1 },
  );
  expect(hits[0]?.frame).toBe(h.source.firstFrame + 3);
  expect(h.renderer.pending).toBeUndefined();
  h.close();
});
it('replays prepared queue entries after another renderer cancels submission', async () => {
  const h = await harness(new SignalSource(16, 512, { blockFrames: 16 }));
  await h.render(false);
  await new Promise((r) => setTimeout(r, 10));
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
  await h.render();
  expect(h.monitor.stats().traces).toBe(16);
  expect(h.renderer.pending).toBeUndefined();
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

it('inspects presented data while replacement is pending', async () => {
  const h = await harness();
  await h.render();
  const old = h.source.data;
  const replacement = new SignalSource(4, 128, { valueOrigin: 100 });
  h.monitor.set({ source: replacement.data });
  const before = await h.monitor.pick([256, 128], { radiusPx: 500, limit: 1 });
  expect(before[0]?.source).toBe(old);
  await h.render();
  h.close();
});
it('keeps application observations usable after destroying a monitor', async () => {
  const source = new SignalSource(2, 32),
    value = source.data,
    h = await harness(source);
  await h.render();
  h.close();
  expect(source.data).toBe(value);
  expect(value.tables.signal.fields.value[0].column.length).toBe(64);
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
  const first = h.requests.mock.calls.map((call) => call[1]).length,
    row = (row: number) => ({ source: h.source.data, index: h.source.index, row });
  h.monitor.select([row(2), row(0)]);
  await h.render();
  const focused = h.requests.mock.calls
    .map((call) => call[1])
    .slice(first)
    .filter((q) => q.kind === 'samples');
  expect(focused.length).toBeGreaterThan(0);
  expect(
    focused.every((q) => q.rows?.kind === 'indices' && [...q.rows.values].join() === '0,2'),
  ).toBe(true);
  h.monitor.set({ camera: { window: [1, 2] } });
  expect(h.monitor.camera).toMatchObject({ window: [1, 2], follow: null, fit: false });
  await h.render();
  expect(cameras).toHaveBeenLastCalledWith(expect.objectContaining({ window: [1, 2] }));
  h.close();
});

it('keeps a pending append when cancellation interrupts domain preparation', async () => {
  const source = new SignalSource(2, 32);
  const h = await harness(source, { camera: { window: [0, 2], fit: true }, autoDomain: 'grow' });
  await h.render();
  source.append(8);
  h.monitor.set({ source: source.data });
  const original = h.rawQuery,
    entered = deferred<void>(),
    gate = deferred<void>();
  let gated = false;
  vi.spyOn(h.gpu, 'query').mockImplementation((querySource, query, options) =>
    (async function* () {
      if (query.kind === 'aggregate' && !gated) {
        gated = true;
        entered.resolve();
        await gate.promise;
      }
      yield* original(querySource, query, options);
    })(),
  );
  const controller = new AbortController();
  const rendering = h.gpu.render({
    timeMs: 0,
    signal: controller.signal,
    views: [{ renderer: h.renderer, target: h.target }],
  });
  const cancelled = expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await cancelled;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await h.render();
  const camera = h.monitor.camera,
    coordinate = source.coordinate(39),
    value = source.value(0, 39);
  const point = [
    12 + ((coordinate - camera.window[0]) / (camera.window[1] - camera.window[0])) * 488,
    12 + ((camera.values[1] - value) / (camera.values[1] - camera.values[0])) * 232,
  ] as const;
  const hits = await h.monitor.pick(point, { radiusPx: 0.1, limit: 8 });
  expect(hits.some((hit) => hit.frame === source.firstFrame + 39 && hit.row === 0)).toBe(true);
  expect(h.renderer.pending).toBeUndefined();
  h.close();
});
it('reprojects cached history after a domain change without rereading observations', async () => {
  const h = await harness(new SignalSource(4, 128));
  await h.render();
  const queries = h.gpu.stats().queries;
  h.monitor.set({ camera: { values: [-4, 4] } });
  await h.render();
  expect(h.gpu.stats().queries).toBe(queries);
  expect(h.monitor.camera.values).toEqual([-4, 4]);
  expect(h.monitor.stats().traces).toBe(4);
  h.close();
});

it('tracks independent sampled fields without dropping trace counts or rereading other fields', async () => {
  const source = new SignalSource(2, 32);
  const h = await harness(source, {
    traces: {
      signal: { from: 'signal', field: 'value' },
      other: { from: 'signal', field: 'other' },
    },
  });
  await h.render();
  let data = source.data;
  for (const [i, field] of ['value', 'other'].entries()) {
    data = appendData(data, 'independent-' + i, [
      {
        kind: 'samples',
        index: source.index,
        rows: { kind: 'range', offset: 0, count: 2 },
        firstFrame: source.firstFrame + 32,
        coordinates: new Float64Array([source.coordinate(32)]),
        columns: {
          [field]: {
            kind: 'numeric',
            values: new Float64Array([3, 4]),
            offset: 0,
            length: 2,
            rowStride: 1,
            frameStride: 2,
          },
        },
      },
    ]);
    const before = h.requests.mock.calls.length;
    h.monitor.set({ source: data });
    await h.render();
    const queries = h.requests.mock.calls
      .slice(before)
      .map((call) => call[1])
      .filter((q) => q.kind === 'samples');
    expect(queries.length).toBeGreaterThan(0);
    expect(
      queries.every(
        (q) =>
          q.select?.includes(field) &&
          q.window.kind === 'frames' &&
          q.window.offset === source.firstFrame + 32,
      ),
    ).toBe(true);
    expect(h.monitor.stats().traces).toBe(4);
  }
  h.close();
});
it('fits appended values using cached bounds and queries only the new interval', async () => {
  const source = new SignalSource(2, 32);
  const h = await harness(source, {
    camera: { window: [0, 2], fit: true },
    autoDomain: 'fit',
    domainPadding: 0,
  });
  await h.render();
  const before = h.requests.mock.calls.length;
  source.append(8);
  h.monitor.set({ source: source.data });
  await h.render();
  const queries = h.requests.mock.calls.slice(before).map((call) => call[1]);
  const bounds = queries.filter((q) => q.kind === 'aggregate');
  expect(bounds.length).toBeGreaterThan(0);
  expect(
    bounds.every((q) => q.window?.kind === 'range' && q.window.between[0] >= source.coordinate(32)),
  ).toBe(true);
  expect(queries.filter((q) => q.kind === 'samples').every((q) => q.window.kind === 'frames')).toBe(
    true,
  );
  const values = Array.from({ length: 80 }, (_, i) => source.value(i % 2, Math.floor(i / 2)));
  expect(h.monitor.camera.values[0]).toBeCloseTo(Math.min(...values), 10);
  expect(h.monitor.camera.values[1]).toBeCloseTo(Math.max(...values), 10);
  h.close();
});
it('refines cached summary boundaries to exact fitted values when following', async () => {
  const source = new SignalSource(2, 2048);
  const h = await harness(source, {
    camera: { window: [0, 20.47], follow: 5, fit: true },
    autoDomain: 'fit',
    domainPadding: 0,
  });
  await h.render();
  source.append(8);
  h.monitor.set({ source: source.data });
  await h.render();
  const [lo, hi] = h.monitor.camera.window;
  const values: number[] = [];
  for (let f = 0; f < source.frames; f++)
    if (source.coordinate(f) >= lo && source.coordinate(f) <= hi)
      for (let r = 0; r < 2; r++) values.push(source.value(r, f));
  expect(h.monitor.camera.values[0]).toBeCloseTo(Math.min(...values), 10);
  expect(h.monitor.camera.values[1]).toBeCloseTo(Math.max(...values), 10);
  h.close();
});

it('bounds derived tile storage and falls back when cached coverage is unavailable', async () => {
  const h = await harness(new SignalSource(2, 64));
  const data = {
    source: h.source.data,
    window: { kind: 'range' as const, between: [0, 1] as const },
    traces: { a: { from: 'signal', field: 'value' } },
  };
  const signal = new AbortController().signal;
  const bindings = await describeBindings(h.gpu, data, signal);
  const cache = new Tiles(512);
  for await (const chunk of history({
    gpu: h.gpu,
    data,
    bindings,
    window: data.window,
    pixels: 512,
    detail: 'full',
    limits: limits(),
    signal,
  })) {
    cache.add(
      { chunk, memo: new Map(), observations: 128, buffers: new Set([new ArrayBuffer(1024)]) },
      [0, 1],
    );
  }
  cache.finish([0, 1], 512, 2, true);
  expect(cache.bytes).toBeLessThanOrEqual(512);
  expect(cache.reuse([0, 1], 512, bindings)).toBeUndefined();
  expect(await cache.bounds('a', [0, 1], signal)).toBeUndefined();
  h.close();
});

it('reads newly exposed existing observations when a follow window extends cached coverage', async () => {
  const source = new SignalSource(2, 64);
  const h = await harness(source, {
    camera: { window: [0, 0.31], follow: 0.32, fit: true },
    autoDomain: 'fit',
    domainPadding: 0,
  });
  await h.render();
  const fields = vi.spyOn(h.gpu, 'fields');
  const before = h.requests.mock.calls.length;
  source.append(1);
  h.monitor.set({ source: source.data });
  await h.render();
  const queries = h.requests.mock.calls
    .slice(before)
    .map((call) => call[1])
    .filter((q) => q.kind === 'samples');
  expect(
    queries.some(
      (q) =>
        q.window.kind === 'frames' &&
        q.window.offset === source.firstFrame + 32 &&
        q.window.count === 1,
    ),
  ).toBe(true);
  expect(queries.every((q) => q.window.kind === 'frames')).toBe(true);
  expect(
    fields.mock.calls.some(
      ([request]) =>
        request.window?.kind === 'frames' &&
        request.window.offset === source.firstFrame + 32 &&
        request.window.count === 33,
    ),
  ).toBe(true);
  const values = Array.from({ length: 66 }, (_, i) => source.value(i % 2, 32 + Math.floor(i / 2)));
  expect(h.monitor.camera.values[0]).toBeCloseTo(Math.min(...values), 10);
  expect(h.monitor.camera.values[1]).toBeCloseTo(Math.max(...values), 10);
  h.close();
});
