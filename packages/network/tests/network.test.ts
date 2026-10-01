import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGpu, type FieldValues } from '@latkit/gpu';
import { createNetwork } from '../src/index.js';
import type { NetworkData } from '../src/data.js';
import { readGeometry, DEFAULT_LIMITS } from '../src/geometry/topology.js';
import { HOVER_EXHAUSTED, PickGeometry } from '../src/picking.js';
import { featureSource } from './paths-fixture.js';
import { GraphSource } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';

function fixture(count = 25, blockRows = 8) {
  const source = new GraphSource(count, blockRows);
  const data: NetworkData = {
    source,
    vertices: { node: { position: 'location', color: { field: 'signal', domain: [0, 1] } } },
    edges: { line: { ends: ['from', 'to'] } },
  };
  return { source, data };
}
function device() {
  const fake = fakeDevice();
  fake.device.createShaderModule = vi.fn(
    () =>
      ({
        getCompilationInfo: () => Promise.resolve({ messages: [] }),
      }) as unknown as GPUShaderModule,
  );
  fake.device.createPipelineLayout = vi.fn(() => ({}) as GPUPipelineLayout);
  const original = fake.device.createCommandEncoder.bind(fake.device);
  fake.device.createCommandEncoder = vi.fn(() => {
    const encoder = original();
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      draw: vi.fn(),
      drawIndirect: vi.fn(),
      end: vi.fn(),
    };
    encoder.clearBuffer = vi.fn();
    encoder.beginComputePass = vi.fn(() => pass as unknown as GPUComputePassEncoder);
    encoder.beginRenderPass = vi.fn(() => pass as unknown as GPURenderPassEncoder);
    return encoder;
  });
  return fake;
}
function target(gpu: Awaited<ReturnType<typeof createGpu>>) {
  const texture = gpu.device.createTexture({
    size: [800, 600],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    device: gpu.device,
    width: 800,
    height: 600,
    format: 'rgba8unorm' as const,
    texture: () => texture,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
beforeEach(() => {
  device();
});

it('keeps model identities across pages and uses CSR neighborhoods', async () => {
  const { source, data } = fixture(100, 3),
    gpu = await createGpu({ device: device().device });
  let geometry!: Awaited<ReturnType<typeof readGeometry>>;
  await gpu.render({
    timeMs: 0,
    views: [
      {
        target: target(gpu),
        renderer: {
          async prepare(frame) {
            geometry = await readGeometry(data, frame, DEFAULT_LIMITS);
          },
          encode() {},
          destroy() {},
        },
      },
    ],
  });
  expect(geometry.vertices.length).toBe(1); // Native query blocks do not become draw banks.
  expect(geometry.segmentCount).toBe(source.from.length);
  const item = { kind: 'vertex' as const, source, index: source.index('node'), row: 55 };
  const neighbors = geometry.adjacency.neighborhood(item, data);
  expect(
    neighbors
      .filter((item) => item.kind === 'vertex')
      .map((item) => item.row)
      .sort((a, b) => a - b),
  ).toEqual([45, 54, 55, 56, 65]);
  expect(neighbors.filter((item) => item.kind === 'edge')).toHaveLength(4);
  gpu.destroy();
});

it('uses one submission and preserves camera-only native cache hits', async () => {
  const { source, data } = fixture(100, 9),
    fake = device(),
    gpu = await createGpu({ device: fake.device }),
    network = createNetwork({ gpu, data });
  const surface = target(gpu),
    render = () =>
      gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface, at: 0 }] });
  await render();
  const queries = source.queries;
  network.panBy(10, 5);
  await render();
  expect(source.queries).toBe(queries);
  expect(fake.queue.submit).toHaveBeenCalledTimes(2);
  expect(network.stats().vertices).toBe(100);
  network.destroy();
  await gpu.idle();
  gpu.trim();
  expect(gpu.stats().gpuBytes).toBe(0);
  expect(gpu.stats().cpuBytes).toBe(0);
  expect(source.listeners.size).toBe(0);
  gpu.destroy();
});

it('picks the submitted frame and does not publish a cancelled candidate', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device }),
    network = createNetwork({ gpu, data });
  const surface = target(gpu);
  await gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface, at: 0 }] });
  const item = { kind: 'vertex' as const, source, index: source.index('node'), row: 12 },
    point = network.locate(item)!;
  expect(network.hitTest(point)[0]?.row).toBe(12);
  network.panBy(100, 0);
  await expect(
    gpu.render({
      timeMs: 1,
      views: [{ renderer: network, target: surface, at: 0 }],
      encode() {
        throw new Error('cancel composition');
      },
    }),
  ).rejects.toThrow('cancel composition');
  expect(network.locate(item)).toEqual(point);
  expect(network.stats().frames).toBe(1);
  await gpu.render({ timeMs: 2, views: [{ renderer: network, target: surface, at: 0 }] });
  expect(network.locate(item)![0]).toBeCloseTo(point[0] + 100);
  network.destroy();
  gpu.destroy();
});

it('rebinds immutable live positions without rereading topology and picks immediately', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device }),
    network = createNetwork({ gpu, data });
  const surface = target(gpu);
  await gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface, at: 0 }] });
  network.setCamera({ fit: false });
  const values = source.positions.slice();
  values[24] += 3;
  values[25] += 2;
  const position: FieldValues = {
    index: source.index('node'),
    rows: { kind: 'range', offset: 0, count: 25 },
    values: {
      kind: 'vector',
      size: 2,
      offset: 0,
      length: 25,
      values: { kind: 'numeric', offset: 0, length: values.length, values },
    },
  };
  const requests = source.queries;
  network.setVertex('node', { position });
  await gpu.render({ timeMs: 1, views: [{ renderer: network, target: surface, at: 0 }] });
  expect(source.queries).toBe(requests);
  const item = { kind: 'vertex' as const, source, index: source.index('node'), row: 12 };
  expect(network.hitTest(network.locate(item)!)[0]?.row).toBe(12);
  network.destroy();
  gpu.destroy();
});

it('preserves an explicit initial camera and rejects incompatible position identities', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const camera = { centerX: 1e9 + 10, centerY: 1e9 + 20, scale: 2, fit: false } as const;
  const network = createNetwork({ gpu, data, camera }),
    surface = target(gpu);
  await gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface, at: 0 }] });
  expect(network.getCamera()).toMatchObject(camera);
  network.setVertex('node', {
    position: {
      index: { ...source.index('node'), version: 'wrong' },
      rows: { kind: 'range', offset: 0, count: 25 },
      values: {
        kind: 'vector',
        size: 2,
        offset: 0,
        length: 25,
        values: { kind: 'numeric', offset: 0, length: 50, values: source.positions },
      },
    },
  });
  await expect(
    gpu.render({ timeMs: 1, views: [{ renderer: network, target: surface, at: 0 }] }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(network.getCamera()).toMatchObject(camera);
  network.destroy();
  gpu.destroy();
});

it('enforces geometry admission limits and keeps borrowed sources open', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device }),
    close = vi.spyOn(source, 'close');
  const network = createNetwork({ gpu, data, limits: { maxVertices: 10 } });
  await expect(
    gpu.render({ timeMs: 0, views: [{ renderer: network, target: target(gpu), at: 0 }] }),
  ).rejects.toMatchObject({ code: 'resource-limit' });
  network.destroy();
  expect(close).not.toHaveBeenCalled();
  gpu.destroy();
});

it('rejects invalid options atomically and guards Cartesian globe use', () => {
  const { data } = fixture(),
    fake = device();
  const gpu = {
    device: fake.device,
    buffer: () => ({ buffer: fake.device.createBuffer({ size: 80, usage: 128 }), destroy() {} }),
  } as unknown as Awaited<ReturnType<typeof createGpu>>;
  const network = createNetwork({ gpu, data });
  expect(network.setCamera({ projection: 'globe' })).toBe(false);
  expect(() => network.setOptions({ edgeWidthPx: NaN })).toThrow();
  expect(() => network.setOptions({ motion: 'broken' as 'auto' })).toThrow();
  network.destroy();
  expect(() => network.setOptions({ edges: false })).toThrow();
});

it('cleans up a source read when destruction interrupts preparation', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  source.query = (() => ({
    async *[Symbol.asyncIterator]() {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { kind: 'schema' as const, version: source.version, schema: source.schema };
    },
  })) as typeof source.query;
  const network = createNetwork({ gpu, data }),
    render = gpu.render({ timeMs: 0, views: [{ renderer: network, target: target(gpu), at: 0 }] });
  await waiting;
  network.destroy();
  await expect(render).rejects.toBeDefined();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await gpu.idle();
  gpu.trim();
  expect(gpu.stats().gpuBytes).toBe(0);
  gpu.destroy();
});

it('coalesces pointer movement into one committed hover search and keeps click picking explicit', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork({ gpu, data, options: { hover: 'on' } }),
    surface = target(gpu);
  const render = () =>
    gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface, at: 0 }] });
  const nearest = vi.spyOn(PickGeometry.prototype, 'nearest'),
    hover = vi.fn();
  network.on('hover', hover);
  await render();
  expect(network.stats().pickingBytes).toBe(0);
  const point = network.locate({ kind: 'vertex', source, index: source.index('node'), row: 12 })!;
  network.setPointer([0, 0]);
  network.setPointer([10, 10]);
  network.setPointer(point);
  expect(nearest).not.toHaveBeenCalled();
  await render();
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({ row: 12, kind: 'vertex' }));
  expect(network.stats().pickingBytes).toBe(0);
  expect(network.hitTest(point)[0]).toMatchObject({ row: 12 });
  expect(network.stats().pickingBytes).toBeGreaterThan(0);
  network.setOptions({ hover: 'off' });
  await render();
  expect(hover).toHaveBeenLastCalledWith(null);
  const invalidate = vi.fn();
  network.on('invalidate', invalidate);
  network.setPointer([1, 2]);
  network.setPointer(null);
  expect(invalidate).not.toHaveBeenCalled();
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(network.hitTest(point)[0]).toMatchObject({ row: 12 });
  network.destroy();
  gpu.destroy();
});

it('aborts automatic searches without a partial hit and latches across pointer and recording changes', async () => {
  const { data, source } = fixture(1000, 1000),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork({
    gpu,
    data: {
      ...data,
      vertices: {
        node: {
          ...data.vertices.node,
          position: { x: 'x', y: 'y' },
          height: { field: 'z', domain: [0, 1] },
        },
      },
    },
    camera: { projection: 'tilt', pitch: 45 },
  });
  const surface = target(gpu),
    render = (at = 0) =>
      gpu.render({ timeMs: at, views: [{ renderer: network, target: surface, at }] });
  await render();
  const nearest = vi.spyOn(PickGeometry.prototype, 'nearest'),
    projected = vi.spyOn(PickGeometry.prototype, 'projected');
  const hover = vi.fn();
  network.on('hover', hover);
  network.setPointer(
    network.locate({ kind: 'vertex', source, index: source.index('node'), row: 0 })!,
  );
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
  await render();
  expect(nearest.mock.results[0].value).toBe(HOVER_EXHAUSTED);
  expect(projected.mock.calls.length).toBeLessThan(1000);
  expect(hover).not.toHaveBeenCalled();
  expect(network.stats()).toMatchObject({ hover: 'budget', pickingBytes: 0 });
  now.mockRestore();
  const invalidation = vi.fn();
  network.on('invalidate', invalidation);
  for (let i = 0; i < 50; i++) network.setPointer([400 + i, 300]);
  expect(invalidation).not.toHaveBeenCalled();
  await render(1);
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(network.stats().hover).toBe('budget');
  // An explicit policy update permits a new attempt; partial results never become hover.
  network.setOptions({ hoverBudgetMs: 1000 });
  await render(1);
  expect(nearest).toHaveBeenCalledTimes(2);
  expect(network.stats()).toMatchObject({ hover: 'active', pickingBytes: 0 });
  network.destroy();
  gpu.destroy();
});

it('pauses auto hover during coordinate and camera motion, then wakes after settling', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { data, source } = fixture(),
    gpu = await createGpu({ device: device().device });
  const movingData: NetworkData = {
    ...data,
    vertices: { node: { ...data.vertices.node, position: { x: 'x', y: 'y' } } },
  };
  const network = createNetwork({ gpu, data: movingData }),
    surface = target(gpu);
  const render = (at: number) =>
    gpu.render({ timeMs: at, views: [{ renderer: network, target: surface, at }] });
  await render(0);
  const nearest = vi.spyOn(PickGeometry.prototype, 'nearest'),
    invalidate = vi.fn();
  network.on('invalidate', invalidate);
  network.setPointer([400, 300]);
  await render(1);
  expect(network.stats()).toMatchObject({ hover: 'moving', pickingBytes: 0 });
  expect(nearest).not.toHaveBeenCalled();
  invalidate.mockClear();
  network.setPointer([401, 300]);
  expect(invalidate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(151);
  expect(invalidate).toHaveBeenCalledTimes(1);
  await render(1);
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(network.stats().hover).toBe('active');
  const ends = source.endsQueries;
  network.panBy(10, 0);
  await render(1);
  expect(network.stats().hover).toBe('moving');
  expect(source.endsQueries).toBe(ends);
  invalidate.mockClear();
  network.destroy();
  invalidate.mockClear();
  await vi.advanceTimersByTimeAsync(200);
  expect(invalidate).not.toHaveBeenCalled();
  gpu.destroy();
});

it('does not publish hover from a failed composition or restore it after pointer exit', async () => {
  const { data, source } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork({ gpu, data, options: { hover: 'on' } }),
    surface = target(gpu);
  const views = [{ renderer: network, target: surface, at: 0 }];
  await gpu.render({ timeMs: 0, views });
  const hover = vi.fn();
  network.on('hover', hover);
  network.setPointer(
    network.locate({ kind: 'vertex', source, index: source.index('node'), row: 12 })!,
  );
  await expect(
    gpu.render({
      timeMs: 0,
      views,
      encode() {
        throw new Error('failed');
      },
    }),
  ).rejects.toThrow('failed');
  expect(hover).not.toHaveBeenCalled();
  const invalidate = vi.fn();
  network.on('invalidate', invalidate);
  await gpu.render({
    timeMs: 0,
    views,
    encode() {
      network.setPointer(null);
    },
  });
  expect(hover).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith('refresh');
  network.destroy();
  gpu.destroy();
});

it('falls back to exact scanning when explicit indexes cannot fit the CPU budget', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const baseline = createNetwork({ gpu, data }),
    surface = target(gpu);
  await gpu.render({ timeMs: 0, views: [{ renderer: baseline, target: surface, at: 0 }] });
  const bytes = baseline.stats().geometryBytes;
  baseline.destroy();
  const network = createNetwork({
    gpu,
    data,
    limits: { cpuBytes: bytes + 1 },
    options: { hover: 'off' },
  });
  await gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface, at: 0 }] });
  const point = network.locate({ kind: 'vertex', source, index: source.index('node'), row: 12 })!;
  expect(network.hitTest(point)[0]).toMatchObject({ row: 12 });
  expect(network.stats().pickingBytes).toBe(0);
  expect(() => network.setOptions({ hoverBudgetMs: 0 })).toThrow();
  expect(() => network.setOptions({ hoverBudgetMs: Infinity })).toThrow();
  expect(() => network.setOptions({ hover: 'invalid' as 'auto' })).toThrow();
  network.destroy();
  gpu.destroy();
});

it('keeps hover active across color-only samples and reuses a valid spatial index', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { data, source } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork({ gpu, data }),
    surface = target(gpu);
  const render = (at: number) =>
    gpu.render({ timeMs: at, views: [{ renderer: network, target: surface, at }] });
  await render(0);
  const point = network.locate({ kind: 'vertex', source, index: source.index('node'), row: 12 })!;
  network.hitTest(point);
  const bytes = network.stats().pickingBytes;
  network.setPointer(point);
  const hover = vi.fn();
  network.on('hover', hover);
  await render(1);
  expect(network.stats()).toMatchObject({ hover: 'active', pickingBytes: bytes });
  expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({ row: 12 }));
  await render(2);
  expect(network.stats()).toMatchObject({ hover: 'active', pickingBytes: bytes });
  network.destroy();
  gpu.destroy();
});

it('renders bends, nets as stars, geodesics, and native paths with original identities', async () => {
  const source = featureSource(),
    gpu = await createGpu({ device: device().device });
  const data: NetworkData = {
    source,
    vertices: { node: { position: 'position' } },
    edges: {
      bend: { ends: ['from', 'to'], bends: 'points' },
      star: {},
      route: { ends: ['from', 'to'], curve: 'geodesic' },
    },
    paths: { seam: { points: 'points', pickable: true } },
  };
  const network = createNetwork({ gpu, data, camera: { centerX: -40, centerY: 0, scale: 5 } });
  const surface = target(gpu),
    render = () => gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface }] });
  await render();
  expect(network.stats().vertices).toBe(4);
  expect(network.stats().edges).toBe(3);
  const star = { kind: 'edge' as const, source, index: source.index('star'), row: 0 };
  expect(
    network
      .neighborhood(star)
      .filter((item) => item.kind === 'vertex')
      .map((item) => item.row)
      .sort(),
  ).toEqual([0, 1, 2, 3]);
  const bend = { kind: 'edge' as const, source, index: source.index('bend'), row: 0 };
  const anchor = network.locate(bend)!;
  expect(anchor).not.toBeNull();
  expect(
    network.hitTest(anchor).some((item) => item.kind === 'edge' && item.index.type === 'bend'),
  ).toBe(true);
  const queries = source.queries;
  network.panBy(3, 2);
  await render();
  expect(source.queries).toBe(queries);
  network.destroy();
  await gpu.idle();
  gpu.trim();
  expect(gpu.stats().gpuBytes).toBe(0);
  gpu.destroy();
});
it('keeps edges pickable when only their vertex markers are hidden', async () => {
  const { source, data } = fixture(4),
    gpu = await createGpu({ device: device().device });
  const hidden: FieldValues = {
    index: source.index('node'),
    rows: { kind: 'range', offset: 0, count: 4 },
    values: { kind: 'boolean', offset: 0, length: 4, values: Uint8Array.of(0) },
  };
  const network = createNetwork({
    gpu,
    data: { ...data, vertices: { node: { ...data.vertices.node, visible: hidden } } },
  });
  await gpu.render({ timeMs: 0, views: [{ renderer: network, target: target(gpu), at: 0 }] });
  const item = { kind: 'edge' as const, source, index: source.index('line'), row: 0 },
    point = network.locate(item)!;
  expect(network.hitTest(point).some((hit) => hit.kind === 'edge' && hit.row === 0)).toBe(true);
  expect(network.hitTest(point).some((hit) => hit.kind === 'vertex')).toBe(false);
  network.destroy();
  gpu.destroy();
});

it('picks a geodesic arc at its visible arc-length midpoint in every projection', async () => {
  const source = featureSource(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork({
    gpu,
    data: {
      source,
      vertices: { node: { position: 'position' } },
      edges: { route: { ends: ['from', 'to'], curve: 'geodesic' } },
    },
    camera: { centerX: -30, centerY: 5, scale: 4 },
    options: { vertices: false, edgeWidthPx: 3 },
  });
  const surface = target(gpu),
    item = { kind: 'edge' as const, source, index: source.index('route'), row: 0 };
  for (const projection of ['flat', 'tilt', 'globe'] as const) {
    network.setCamera({ projection, pitch: projection === 'tilt' ? 40 : 0 });
    await gpu.render({ timeMs: 0, views: [{ renderer: network, target: surface }] });
    const point = network.locate(item)!;
    expect(point).not.toBeNull();
    expect(network.hitTest(point).some((hit) => hit.index.type === 'route')).toBe(true);
  }
  network.destroy();
  gpu.destroy();
});
