import { describe, it, expect, vi } from 'vitest';
import { createGpu, kit } from '@latkit/gpu';
import { createMonitor, type Monitor, type MonitorConfig } from '../src/index.js';
import { SignalSource } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';
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
    source,
    traces: { signal: { from: 'signal', field: 'value' } },
    camera: {
      window: [source.coordinate(source.before), source.coordinate(source.frames + 127)],
      values: [(source.options.valueOrigin ?? 0) - 2, (source.options.valueOrigin ?? 0) + 2],
    },
    coordinateAxis: false,
    valueAxis: false,
    ...options,
  });
  const renderer = kit.rendererOf(monitor);
  const render = (complete = true, at?: number) =>
    gpu.render({
      views: [{ renderer, target, at }],
      timeMs: 10,
      ...(complete ? { completion: 'complete' as const } : {}),
    });
  return {
    fake,
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
    const reads = h.source.reads,
      uploads = h.gpu.stats().uploadedBytes;
    for (let i = 0; i < 6; i++) await h.render(true, i);
    expect(h.source.reads).toBe(reads);
    expect(h.gpu.stats().uploadedBytes - uploads).toBeLessThan(8192);
    h.close();
    expect(h.source.closed).toBe(false);
    expect(h.source.active).toBe(0);
  });
  it('resizes the committed image without reads until resizing settles', async () => {
    const h = await harness();
    await h.render();
    const reads = h.source.reads;
    h.target.resize({ width: 600, height: 300 });
    await h.render(false);
    expect(h.source.reads).toBe(reads);
    await h.render();
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('appends only new frames and keeps the fixed-domain history', async () => {
    const h = await harness();
    await h.render();
    const first = h.source.requests.length;
    h.source.append(8);
    await h.render();
    const queries = h.source.requests
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
    const first = source.requests.length;
    h.monitor.select([hits.find((hit) => hit.row === 1)!]);
    await h.render();
    expect(
      source.requests
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
    expect(h.source.active).toBe(0);
    expect(h.renderer.pending).toBeUndefined();
    h.target.destroy();
    h.gpu.destroy();
  });
  it('fails explicitly when rows exceed the configured capacity', async () => {
    const h = await harness();
    h.monitor.destroy();
    const view = createMonitor(h.gpu, {
      source: h.source,
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
    await h.render();
    expect(h.renderer.pending).toBeUndefined();
    h.close();
  });
  it('does not submit partial work when another renderer fails', async () => {
    const h = await harness();
    await h.render();
    const n = h.fake.queue.submit.mock.calls.length;
    const broken: kit.Renderer = {
      async prepare() {
        throw new Error('other renderer');
      },
      encode() {},
      destroy() {},
    };
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
    source: h.source,
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
  const reads = h.source.reads;
  pointer(h.monitor, [258, 128]);
  await new Promise((r) => setTimeout(r, 60));
  expect(h.source.reads).toBe(reads);
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
  h.renderer.on!('invalidate', (value) => events.push(value));
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
  const reads = h.source.reads,
    uploads = h.gpu.stats().uploadedBytes;
  for (let i = 0; i < 8; i++) {
    pointer(h.monitor, [200 + i, 100]);
    await h.render(false);
  }
  expect(h.source.reads).toBe(reads);
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
  expect(h.source.active).toBe(0);
});
it('makes progress during continuous appends without restarting history', async () => {
  const h = await harness(new SignalSource(32, 512, { blockFrames: 16 }));
  const invalidations: string[] = [];
  h.renderer.on!('invalidate', (v) => invalidations.push(v));
  await h.render(false);
  for (let i = 0; i < 30; i++) {
    h.source.append(1);
    await new Promise((r) => setTimeout(r, 2));
    await h.render(false);
  }
  expect(h.monitor.stats().visible).toBe(true);
  expect(invalidations).not.toContain('replace');
  await h.render();
  expect(h.renderer.pending).toBeUndefined();
  const count = h.source.requests.filter(
    (q) => q.kind === 'samples' && q.window.kind === 'range',
  ).length;
  expect(count).toBeLessThan(20);
  h.close();
});
it('accepts single observations after an initially empty source', async () => {
  const h = await harness(new SignalSource(1, 0));
  await h.render();
  for (let i = 0; i < 4; i++) {
    h.source.append(1);
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
  const broken: kit.Renderer = {
    async prepare() {
      throw new Error('cancel frame');
    },
    encode() {},
    destroy() {},
  };
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
  const reads = h.source.reads;
  expect(await h.monitor.pick(point, { limit: 1 })).toEqual(first);
  expect(h.source.reads).toBe(reads);
  h.close();
});

it('does not inspect replaced observations before replacement is presented', async () => {
  const h = await harness();
  await h.render();
  h.source.version = 'replaced';
  for (const listener of h.source.listeners)
    listener({ kind: 'replace', version: h.source.version });
  await expect(h.monitor.pick([256, 128])).rejects.toMatchObject({ code: 'conflict' });
  await h.render();
  h.close();
});
it('releases owned acquisitions when sources are replaced or the monitor closes', async () => {
  const source = new SignalSource(2, 32),
    owned: SignalSource[] = [];
  const retain = source.retain.bind(source);
  source.retain = async (options) => {
    const fixed = await retain(options);
    owned.push(fixed);
    return fixed;
  };
  const h = await harness(source);
  await h.render();
  h.monitor.select([{ source, index: source.index, row: 1, field: 'value' }]);
  await h.render();
  expect(owned.length).toBe(1);
  h.close();
  await new Promise((r) => setTimeout(r, 10));
  expect(owned.every((v) => v.closed)).toBe(true);
  expect(source.closed).toBe(false);
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
  const first = h.source.requests.length,
    row = (row: number) => ({ source: h.source, index: h.source.index, row });
  h.monitor.select([row(2), row(0)]);
  await h.render();
  const focused = h.source.requests.slice(first).filter((q) => q.kind === 'samples');
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
