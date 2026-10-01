import { describe, it, expect } from 'vitest';
import { createGpu, createRenderTarget, type Renderer } from '@latkit/gpu';
import { createMonitor } from '../src/index.js';
import { SignalSource } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';
import { ticks } from '../src/ticks.js';
import { Seams } from '../src/segments.js';
import { describeBindings } from '../src/bindings.js';
import { history, isEnvelope } from '../src/history.js';
import { limits } from '../src/config.js';
async function harness(
  source = new SignalSource(4, 128),
  options: Parameters<typeof createMonitor>[0]['options'] = {},
) {
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
  const target = createRenderTarget({ gpu, width: 512, height: 256 });
  const monitor = createMonitor({
    gpu,
    data: {
      source,
      window: {
        kind: 'range',
        between: [source.coordinate(source.before), source.coordinate(source.frames + 127)],
      },
      traces: { signal: { from: 'signal', field: 'value' } },
    },
    options: {
      coordinateAxis: null,
      valueAxis: null,
      valueDomain: [(source.options.valueOrigin ?? 0) - 2, (source.options.valueOrigin ?? 0) + 2],
      ...options,
    },
  });
  const render = (complete = true, at?: number) =>
    gpu.render({
      views: [{ renderer: monitor, target, at }],
      timeMs: 10,
      ...(complete ? { completion: 'complete' as const } : {}),
    });
  return {
    fake,
    gpu,
    target,
    monitor,
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
    expect(h.monitor.pending).toBeUndefined();
    const reads = h.source.reads,
      uploads = h.gpu.stats().uploadedBytes;
    for (let i = 0; i < 6; i++) await h.render(true, i);
    expect(h.source.reads).toBe(reads);
    expect(h.gpu.stats().uploadedBytes - uploads).toBeLessThan(8192);
    h.close();
    expect(h.source.closed).toBe(false);
    expect(h.source.active).toBe(0);
  });
  it('reprojects camera movement without reads until navigation settles', async () => {
    const h = await harness();
    await h.render();
    const reads = h.source.reads;
    h.monitor.panBy(10, 0);
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
          q.window.count === 8,
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
    const camera = h.monitor.getCamera()!,
      value = source.value(1, 10),
      coordinate = source.coordinate(10),
      point = [
        256 + (coordinate - camera.center[0]) * camera.scale[0],
        128 - (value - camera.center[1]) * camera.scale[1],
      ] as const;
    const hits = await h.monitor.hitTest(point, { radiusPx: 0.1, limit: 4 });
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
    h.monitor.select(hits.find((hit) => hit.row === 1)!);
    await h.render();
    expect(
      source.requests
        .slice(first)
        .filter((q) => q.kind === 'samples')
        .every((q) => q.rows?.kind === 'range' && q.rows.offset === 1 && q.rows.count === 1),
    ).toBe(true);
    h.close();
  });
  it('updates follow and excludes evicted observations', async () => {
    const h = await harness(new SignalSource(3, 128), { follow: { span: 0.5 } });
    await h.render();
    h.source.append(8);
    await h.render();
    const camera = h.monitor.getCamera()!;
    expect(camera.center[0]).toBeCloseTo(h.source.coordinate(135) - 0.25);
    h.source.evict(100);
    await h.render();
    expect(h.monitor.stats().refining).toBe(false);
    h.close();
  });
  it('cancels a pending progressive generation and releases its iterator', async () => {
    const h = await harness(new SignalSource(128, 4096));
    await h.render(false);
    h.monitor.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.source.active).toBe(0);
    expect(h.monitor.pending).toBeUndefined();
    h.target.destroy();
    h.gpu.destroy();
  });
  it('fails explicitly when rows exceed the configured capacity', async () => {
    const h = await harness();
    h.monitor.destroy();
    const view = createMonitor({
      gpu: h.gpu,
      data: {
        source: h.source,
        window: { kind: 'range', between: [0, 2] },
        traces: { a: { from: 'signal', field: 'value' } },
      },
      limits: { rows: 1 },
      options: { valueDomain: [-2, 2], coordinateAxis: null, valueAxis: null },
    });
    await expect(
      h.gpu.render({
        timeMs: 0,
        views: [{ renderer: view, target: h.target }],
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
    expect(h.monitor.pending).toBeUndefined();
    h.close();
  });
  it('does not submit partial work when another renderer fails', async () => {
    const h = await harness();
    await h.render();
    const n = h.fake.queue.submit.mock.calls.length;
    const broken: Renderer = {
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
          { renderer: h.monitor, target: h.target },
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

it('suspends automatic hover when refinement exceeds its soft budget',async()=>{
 const h=await harness(new SignalSource(256,128),{hover:'auto',hoverBudgetMs:0.000001});await h.render();h.monitor.setPointer([256,128]);await new Promise(r=>setTimeout(r,80));expect(h.monitor.stats().hover).toBe('budget');const reads=h.source.reads;h.monitor.setPointer([258,128]);await new Promise(r=>setTimeout(r,60));expect(h.source.reads).toBe(reads);h.monitor.setOptions({hover:'off'});expect(h.monitor.stats().hover).toBe('off');h.close();
});
