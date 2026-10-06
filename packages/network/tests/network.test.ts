import { renderer as testRenderer } from '../../gpu/tests/fixtures/public-render.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGpu, kit } from '@latkit/gpu';
import { createData, type FieldInput, type FieldValues, type NumericColumn } from '@latkit/model';
import { arrange, createNetwork, type Network, type NetworkConfig } from '../src/index.js';
import type { NetworkData } from '../src/data.js';
import { readGeometry, DEFAULT_LIMITS } from '../src/geometry/topology.js';
import { PickGeometry } from '../src/picking.js';
import { featureSource } from './paths-fixture.js';
import { GraphSource } from './fixture.js';
import { deferred, fakeDevice } from '../../gpu/tests/fixtures/device.js';

/** Both lanes of a two-component position field. */
const lanes = (field: FieldInput) => ({ x: field, y: { field, component: 1 } });
function fixture(count = 25, blockRows = 8) {
  const source = new GraphSource(count, blockRows);
  const data: NetworkData = {
    source: source.data,
    vertices: { node: { ...lanes('location'), color: { field: 'signal', domain: [0, 1] } } },
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
/** Drive the pointer as input does. */
const pointer = (network: Network, point: readonly [number, number] | null) =>
  (network as unknown as { pointer(point: readonly [number, number] | null): void }).pointer(point);
/** Pan by pixels on a flat, unrotated camera, as a drag does. */
function pan(network: Network, dx: number, dy: number): void {
  const { center, scale } = network.camera;
  network.set({ camera: { center: [center[0] - dx / scale, center[1] + dy / scale] } });
}
const invalidations = (network: Network) => kit.rendererOf(network).on!.bind(null, 'invalidate');
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
        renderer: testRenderer(async (frame) => {
          geometry = await readGeometry(data, frame.reader, DEFAULT_LIMITS);
        }),
      },
    ],
  });
  expect(geometry.vertices.length).toBe(1); // Native query blocks do not become draw banks.
  expect(geometry.segmentCount).toBe(source.from.length);
  const item = {
    kind: 'vertex' as const,
    source: source.data,
    index: source.index('node'),
    row: 55,
  };
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
    network = createNetwork(gpu, data);
  const surface = target(gpu),
    render = () =>
      gpu.render({
        timeMs: 0,
        views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
      });
  await render();
  const queries = source.queries;
  pan(network, 10, 5);
  await render();
  expect(source.queries).toBe(queries);
  expect(fake.queue.submit).toHaveBeenCalledTimes(2);
  expect(network.stats().vertices).toBe(100);
  network.destroy();
  await gpu.idle();
  gpu.trim();
  expect(gpu.stats().gpuBytes).toBe(0);
  expect(gpu.stats().cpuBytes).toBe(0);
  gpu.destroy();
});

it('picks the submitted frame and does not publish a cancelled candidate', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device }),
    network = createNetwork(gpu, data);
  const surface = target(gpu);
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
  });
  const item = {
      kind: 'vertex' as const,
      source: source.data,
      index: source.index('node'),
      row: 12,
    },
    point = network.locate(item)!;
  expect((await network.pick(point))[0]?.row).toBe(12);
  pan(network, 100, 0);
  await expect(
    gpu.render({
      timeMs: 1,
      views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
      encode() {
        throw new Error('cancel composition');
      },
    }),
  ).rejects.toThrow('cancel composition');
  expect(network.locate(item)).toEqual(point);
  expect(network.stats().frames).toBe(1);
  await gpu.render({
    timeMs: 2,
    views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
  });
  expect(network.locate(item)![0]).toBeCloseTo(point[0] + 100);
  network.destroy();
  gpu.destroy();
});

it('rebinds immutable live positions without rereading topology and picks immediately', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device }),
    network = createNetwork(gpu, data);
  const surface = target(gpu);
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
  });
  network.set({ camera: { fit: false } });
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
  const requests = source.queries,
    topology = (network as unknown as { geometry?: object }).geometry;
  network.set({ vertices: { node: lanes(position) } });
  // Positions of the same kind keep the topology.
  expect((network as unknown as { geometry?: object }).geometry).toBe(topology);
  await gpu.render({
    timeMs: 1,
    views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
  });
  expect(source.queries).toBe(requests);
  const item = {
    kind: 'vertex' as const,
    source: source.data,
    index: source.index('node'),
    row: 12,
  };
  expect((await network.pick(network.locate(item)!))[0]?.row).toBe(12);
  network.destroy();
  gpu.destroy();
});

it('preserves an explicit initial camera and rejects incompatible position identities', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const camera = { center: [1e9 + 10, 1e9 + 20] as const, scale: 2, fit: false };
  const network = createNetwork(gpu, { ...data, camera }),
    surface = target(gpu);
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
  });
  expect(network.camera).toMatchObject(camera);
  network.set({
    vertices: {
      node: lanes({
        index: { ...source.index('node'), version: 'wrong' },
        rows: { kind: 'range', offset: 0, count: 25 },
        values: {
          kind: 'vector',
          size: 2,
          offset: 0,
          length: 25,
          values: { kind: 'numeric', offset: 0, length: 50, values: source.positions },
        },
      }),
    },
  });
  await expect(
    gpu.render({
      timeMs: 1,
      views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(network.camera).toMatchObject(camera);
  network.destroy();
  gpu.destroy();
});

it('enforces geometry admission limits and keeps borrowed sources open', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, { ...data, limits: { vertices: 10 } });
  await expect(
    gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
    }),
  ).rejects.toMatchObject({ code: 'resource-limit' });
  network.destroy();
  expect(source.data).toBe(data.source);
  gpu.destroy();
});

it('rejects invalid options atomically and falls back from the globe for Cartesian data', async () => {
  const { data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, data),
    config = network.config;
  expect(() => network.set({ edgeWidthPx: NaN })).toThrow();
  expect(() => network.set({ motion: 'broken' as 'auto' })).toThrow();
  expect(() => network.set({ unknown: 1 } as never)).toThrow('Unknown network option');
  expect(() => network.set({ camera: { zoom: 2 } as never })).toThrow('Unknown camera option');
  expect(() => network.set({ input: 'edit' })).toThrow('Unsupported input mode');
  expect(() => network.set({ layout: { vertexGap: -1 } })).toThrow('Invalid vertexGap');
  expect(() => network.set({ layout: { algorithm: 'circle' as 'stress' } })).toThrow();
  expect(network.config).toBe(config);
  expect(network.camera).not.toHaveProperty('zoom');
  network.set({ camera: { projection: 'globe' } });
  expect(network.camera.projection).toBe('globe');
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
  });
  expect(network.projections.globe).toBe(false);
  expect(network.camera.projection).toBe('flat');
  network.destroy();
  expect(() => network.set({ lines: false })).toThrow('destroyed');
  gpu.destroy();
});

it('exports frames without moving what pick, locate, and the orbit see', async () => {
  const { data, source } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, { ...data, hover: 'off' }),
    surface = target(gpu),
    vertex = { kind: 'vertex', source: source.data, index: source.index('node'), row: 12 } as const;
  const camera = vi.fn();
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
  });
  const point = network.locate(vertex)!;
  network.on('camera', camera);
  network.set({ camera: { orbit: true } });
  const turned = network.camera;
  await gpu.render({
    timeMs: 5000,
    views: [
      {
        renderer: kit.rendererOf(network),
        target: surface,
        at: 1,
        viewport: { width: 200, height: 600, pixelRatio: 1 },
        presented: false,
      },
    ],
  });
  await Promise.resolve();
  expect(network.locate(vertex)).toEqual(point);
  expect(network.camera).toBe(turned);
  expect(camera).not.toHaveBeenCalled();
  expect((await network.pick(point))[0]).toMatchObject({ row: 12 });
  network.destroy();
  gpu.destroy();
});

it('cleans up a source read when destruction interrupts preparation', async () => {
  const { data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, data),
    render = gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
    });
  await Promise.resolve();
  network.destroy();
  await expect(render).rejects.toBeDefined();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await gpu.idle();
  gpu.trim();
  expect(gpu.stats().gpuBytes).toBe(0);
  gpu.destroy();
});

it('coalesces pointer movement into one committed hover search that never builds an index', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, { ...data, hover: 'on' }),
    surface = target(gpu);
  const render = () =>
    gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
    });
  const nearest = vi.spyOn(PickGeometry.prototype, 'nearest'),
    hover = vi.fn();
  network.on('hover', hover);
  await render();
  expect(network.stats().pickingBytes).toBe(0);
  const point = network.locate({
    kind: 'vertex',
    source: source.data,
    index: source.index('node'),
    row: 12,
  })!;
  pointer(network, [0, 0]);
  pointer(network, [10, 10]);
  pointer(network, point);
  expect(nearest).not.toHaveBeenCalled();
  await render();
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({ row: 12, kind: 'vertex' }));
  expect(network.stats().pickingBytes).toBe(0);
  expect((await network.pick(point))[0]).toMatchObject({ row: 12 });
  expect(network.stats().pickingBytes).toBeGreaterThan(0);
  network.set({ hover: 'off' });
  await render();
  expect(hover).toHaveBeenLastCalledWith(null);
  const invalidate = vi.fn();
  invalidations(network)(invalidate);
  pointer(network, [1, 2]);
  pointer(network, null);
  expect(invalidate).not.toHaveBeenCalled();
  expect(nearest).toHaveBeenCalledTimes(1);
  expect((await network.pick(point))[0]).toMatchObject({ row: 12 });
  network.destroy();
  gpu.destroy();
});

it('aborts automatic searches without a partial hit and suspends them until positions move', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { data, source } = fixture(1000, 1000),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, {
    ...data,
    vertices: {
      node: {
        ...data.vertices.node,
        x: 'x',
        y: 'y',
        z: { field: 'z', domain: [0, 1] },
      },
    },
    camera: { projection: 'tilt', pitch: 45 },
  });
  const surface = target(gpu),
    render = (at = 0) =>
      gpu.render({
        timeMs: at,
        views: [{ renderer: kit.rendererOf(network), target: surface, at }],
      });
  await render();
  const nearest = vi.spyOn(PickGeometry.prototype, 'nearest'),
    projected = vi.spyOn(PickGeometry.prototype, 'projected');
  const hover = vi.fn();
  network.on('hover', hover);
  pointer(
    network,
    network.locate({ kind: 'vertex', source: source.data, index: source.index('node'), row: 0 })!,
  );
  let clock = performance.now();
  const now = vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
  await render();
  expect(nearest.mock.results[0].type).toBe('throw');
  expect(projected.mock.calls.length).toBeLessThan(1000);
  expect(hover).not.toHaveBeenCalled();
  expect(network.stats()).toMatchObject({ hover: 'budget', pickingBytes: 0 });
  now.mockRestore();
  // A miss suspends automatic hover across pointer moves while the scene holds still.
  const invalidation = vi.fn();
  invalidations(network)(invalidation);
  for (let i = 0; i < 50; i++) pointer(network, [400 + i, 300]);
  expect(invalidation).not.toHaveBeenCalled();
  await render();
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(network.stats().hover).toBe('budget');
  // A recording change moves the positions; search resumes once they settle.
  await render(1);
  expect(network.stats().hover).toBe('moving');
  expect(nearest).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(151);
  expect(invalidation).toHaveBeenCalled();
  await render(1);
  expect(nearest).toHaveBeenCalledTimes(2);
  expect(nearest.mock.results[1].type).toBe('return');
  // Tilted views search without indexes.
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
    vertices: { node: { ...data.vertices.node, x: 'x', y: 'y' } },
  };
  const network = createNetwork(gpu, movingData),
    surface = target(gpu);
  const render = (at: number) =>
    gpu.render({ timeMs: at, views: [{ renderer: kit.rendererOf(network), target: surface, at }] });
  await render(0);
  const nearest = vi.spyOn(PickGeometry.prototype, 'nearest'),
    invalidate = vi.fn();
  invalidations(network)(invalidate);
  pointer(network, [400, 300]);
  await render(1);
  expect(network.stats()).toMatchObject({ hover: 'moving', pickingBytes: 0 });
  expect(nearest).not.toHaveBeenCalled();
  invalidate.mockClear();
  pointer(network, [401, 300]);
  expect(invalidate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(151);
  expect(invalidate).toHaveBeenCalledTimes(1);
  await render(1);
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(network.stats().hover).toBe('active');
  const ends = source.endsQueries;
  pan(network, 10, 0);
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
  const network = createNetwork(gpu, { ...data, hover: 'on' }),
    surface = target(gpu);
  const views = [{ renderer: kit.rendererOf(network), target: surface, at: 0 }];
  await gpu.render({ timeMs: 0, views });
  const hover = vi.fn();
  network.on('hover', hover);
  pointer(
    network,
    network.locate({ kind: 'vertex', source: source.data, index: source.index('node'), row: 12 })!,
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
  invalidations(network)(invalidate);
  await gpu.render({
    timeMs: 0,
    views,
    encode() {
      pointer(network, null);
    },
  });
  expect(hover).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith();
  network.destroy();
  gpu.destroy();
});

it('falls back to exact scanning when explicit indexes cannot fit the picking budget', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device }),
    surface = target(gpu);
  const network = createNetwork(gpu, { ...data, limits: { pickingBytes: 1 }, hover: 'off' });
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
  });
  const point = network.locate({
    kind: 'vertex',
    source: source.data,
    index: source.index('node'),
    row: 12,
  })!;
  expect((await network.pick(point))[0]).toMatchObject({ row: 12 });
  expect(network.stats().pickingBytes).toBe(0);
  expect(() => network.set({ hoverBudgetMs: 0 })).toThrow();
  expect(() => network.set({ hoverBudgetMs: Infinity })).toThrow();
  expect(() => network.set({ hover: 'invalid' as 'auto' })).toThrow();
  network.destroy();
  gpu.destroy();
});

it('builds hit-test indexes in the background once positions hold, within pickingBytes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { data, source } = fixture(),
    gpu = await createGpu({ device: device().device }),
    surface = target(gpu),
    full = kit.BoxIndex.bytes(25) + kit.BoxIndex.bytes(source.from.length);
  const build = vi.spyOn(kit.BoxIndex, 'build'),
    query = vi.spyOn(kit.BoxIndex.prototype, 'some'),
    hover = vi.fn();
  const show = async (config: Partial<NetworkConfig> = {}) => {
    const network = createNetwork(gpu, { ...data, hover: 'on', ...config });
    const render = (at = 0) =>
      gpu.render({
        timeMs: at,
        views: [{ renderer: kit.rendererOf(network), target: surface, at }],
      });
    await render();
    return { network, render };
  };
  const { network, render } = await show(),
    vertex = { kind: 'vertex', source: source.data, index: source.index('node'), row: 12 } as const,
    point = network.locate(vertex)!;
  network.on('hover', hover);
  pointer(network, point);
  await render();
  // Drawing and hover never build; hover scans until an index is ready.
  expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({ row: 12 }));
  expect(build).not.toHaveBeenCalled();
  expect(network.stats().pickingBytes).toBe(0);
  await vi.advanceTimersByTimeAsync(150);
  expect(build).toHaveBeenCalledTimes(2);
  expect(network.stats().pickingBytes).toBe(full);
  pointer(network, [point[0] + 1, point[1]]);
  await render();
  expect(query).toHaveBeenCalled();
  expect(hover).toHaveBeenCalledTimes(1);
  // Positions that move again before they hold build nothing; the last ones build once settled.
  network.set({ vertices: { node: { x: 'x', y: 'y' } } });
  await render(1);
  await vi.advanceTimersByTimeAsync(100);
  await render(2);
  await vi.advanceTimersByTimeAsync(149);
  expect(build).toHaveBeenCalledTimes(2);
  expect(network.stats().pickingBytes).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(build).toHaveBeenCalledTimes(4);
  expect(network.stats().pickingBytes).toBe(full);
  // An explicit pick starts the build at once and waits for it, leaving nothing for later.
  network.set({ vertices: { node: lanes('location') } });
  await render();
  expect((await network.pick(point))[0]).toMatchObject({ row: 12 });
  expect(build).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(150);
  expect(build).toHaveBeenCalledTimes(6);
  network.destroy();
  // Only what fits is admitted; destroy stops a build that has not started.
  const bounded = await show({ limits: { pickingBytes: kit.BoxIndex.bytes(25) } });
  await vi.advanceTimersByTimeAsync(150);
  expect(bounded.network.stats().pickingBytes).toBe(kit.BoxIndex.bytes(25));
  await bounded.network.pick(point);
  expect(bounded.network.stats().pickingBytes).toBe(kit.BoxIndex.bytes(25));
  bounded.network.destroy();
  const destroyed = await show();
  build.mockClear();
  destroyed.network.destroy();
  await vi.advanceTimersByTimeAsync(150);
  expect(build).not.toHaveBeenCalled();
  gpu.destroy();
});

it('keeps hover active across color-only samples and reuses a valid spatial index', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { data, source } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, data),
    surface = target(gpu);
  const render = (at: number) =>
    gpu.render({ timeMs: at, views: [{ renderer: kit.rendererOf(network), target: surface, at }] });
  await render(0);
  const point = network.locate({
    kind: 'vertex',
    source: source.data,
    index: source.index('node'),
    row: 12,
  })!;
  await network.pick(point);
  const bytes = network.stats().pickingBytes;
  pointer(network, point);
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
    source: source.data,
    vertices: { node: lanes('position') },
    edges: {
      bend: { ends: ['from', 'to'], bends: 'points' },
      star: {},
      route: { ends: ['from', 'to'], route: 'geodesic' },
    },
    paths: { seam: { points: 'points', pickable: true } },
  };
  const network = createNetwork(gpu, { ...data, camera: { center: [-40, 0], scale: 5 } });
  const surface = target(gpu),
    render = () =>
      gpu.render({ timeMs: 0, views: [{ renderer: kit.rendererOf(network), target: surface }] });
  await render();
  expect(network.stats().vertices).toBe(4);
  expect(network.stats().edges).toBe(3);
  const star = { kind: 'edge' as const, source: source.data, index: source.index('star'), row: 0 };
  expect(
    network
      .neighborhood(star)
      .filter((item) => item.kind === 'vertex')
      .map((item) => item.row)
      .sort(),
  ).toEqual([0, 1, 2, 3]);
  const bend = { kind: 'edge' as const, source: source.data, index: source.index('bend'), row: 0 };
  const anchor = network.locate(bend)!;
  expect(anchor).not.toBeNull();
  expect(
    (await network.pick(anchor)).some((item) => item.kind === 'edge' && item.index.type === 'bend'),
  ).toBe(true);
  const queries = source.queries;
  pan(network, 3, 2);
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
  const network = createNetwork(gpu, {
    ...data,
    vertices: { node: { ...data.vertices.node, visible: hidden } },
  });
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
  });
  const item = { kind: 'edge' as const, source: source.data, index: source.index('line'), row: 0 },
    point = network.locate(item)!;
  expect((await network.pick(point)).some((hit) => hit.kind === 'edge' && hit.row === 0)).toBe(
    true,
  );
  expect((await network.pick(point)).some((hit) => hit.kind === 'vertex')).toBe(false);
  network.destroy();
  gpu.destroy();
});

it('reads every channel as one value for all rows, a field, or a field through a scale', async () => {
  const { source, data } = fixture(2),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, {
    ...data,
    // A constant axis lays rows along the other; a constant visibility hides every marker.
    vertices: { node: { x: 'location', y: 0, visible: false } },
    // Each line draws as wide as its own field's value: row 0's signal maps to 6 CSS pixels.
    edges: {
      line: { ends: ['from', 'to'], widthPx: { field: 'signal', domain: [0, 1], range: [0, 12] } },
    },
  });
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
  });
  const vertex = (row: number) =>
      ({ kind: 'vertex', source: source.data, index: source.index('node'), row }) as const,
    line = { kind: 'edge', source: source.data, index: source.index('line'), row: 0 } as const;
  const [a, b] = [network.locate(vertex(0))!, network.locate(vertex(1))!],
    middle = network.locate(line)!;
  expect(a[1]).toBeCloseTo(b[1]);
  expect(middle[1]).toBeCloseTo(a[1]);
  const hit = async (dy: number) =>
    (await network.pick([middle[0], middle[1] + dy], { radiusPx: 0 })).map((item) => item.kind);
  expect(await hit(0)).toEqual(['edge']);
  expect(await hit(2.5)).toEqual(['edge']);
  expect(await hit(4.5)).toEqual([]);
  network.destroy();
  gpu.destroy();
});

it('picks a geodesic arc at its visible arc-length midpoint in every projection', async () => {
  const source = featureSource(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, {
    source: source.data,
    vertices: { node: lanes('position') },
    edges: { route: { ends: ['from', 'to'], route: 'geodesic' } },
    camera: { center: [-30, 5], scale: 4 },
    markers: false,
    edgeWidthPx: 3,
  });
  const surface = target(gpu),
    item = { kind: 'edge' as const, source: source.data, index: source.index('route'), row: 0 };
  for (const projection of ['flat', 'tilt', 'globe'] as const) {
    network.set({ camera: { projection, pitch: projection === 'tilt' ? 40 : 0 } });
    await gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: surface }],
    });
    const point = network.locate(item)!;
    expect(point).not.toBeNull();
    expect((await network.pick(point)).some((hit) => hit.index.type === 'route')).toBe(true);
  }
  network.destroy();
  gpu.destroy();
});

it('halos every selected item and its ends, binds field names, and reports camera changes', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, {
    ...data,
    vertices: { node: { ...lanes('location'), color: { field: 'signal', colormap: 'viridis' } } },
    edges: { line: { ends: ['from', 'to'], color: 'signal' } },
  });
  const render = () =>
    gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
    });
  const cameras = vi.fn();
  network.on('camera', cameras);
  await render();
  expect(cameras).toHaveBeenCalledTimes(1);
  expect(cameras.mock.lastCall?.[0]).toMatchObject({ fit: true, orbit: false });
  const level = (dense: number) => {
    const focus = (network as unknown as { painter: { focus: kit.BufferData } }).painter.focus;
    const words = new Uint32Array(focus.bytes.buffer, focus.bytes.byteOffset, focus.size / 4);
    return (words[dense >>> 4] >>> ((dense & 15) * 2)) & 3;
  };
  const node = (row: number) =>
      ({ kind: 'vertex', source: source.data, index: source.index('node'), row }) as const,
    line = { kind: 'edge', source: source.data, index: source.index('line'), row: 0 } as const;
  network.select([node(12), node(20), line]);
  await render();
  // Vertices come first, then edges: line 0 is dense address 25.
  expect([12, 20, 25, source.from[0], source.to[0]].map(level)).toEqual([2, 2, 2, 2, 2]);
  network.select([node(20)]);
  await render();
  expect([12, 20, 25].map(level)).toEqual([0, 2, 0]);
  expect(network.selection).toEqual([node(20)]);
  expect(cameras).toHaveBeenCalledTimes(1);
  network.set({ camera: { scale: network.camera.scale * 2 } });
  expect(network.camera.fit).toBe(false);
  await render();
  expect(cameras).toHaveBeenCalledTimes(2);
  network.set({ camera: null });
  expect(network.camera.fit).toBe(true);
  network.destroy();
  gpu.destroy();
});

it('submits a captured network while batches coalesce into the next snapshot', async () => {
  const first = fixture(20),
    fake = device(),
    gpu = await createGpu({ device: fake.device });
  const entered = deferred<void>(),
    gate = deferred<void>(),
    original = gpu.renderPipeline.bind(gpu);
  vi.spyOn(gpu, 'renderPipeline').mockImplementation(async (...args) => {
    entered.resolve();
    await gate.promise;
    return original(...args);
  });
  const network = createNetwork(gpu, first.data),
    surface = target(gpu);
  const draw = () =>
    gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: surface, at: 0 }],
    });
  const rendering = draw();
  await entered.promise;
  for (let n = 21; n <= 30; n++) network.set({ source: fixture(n).source.data });
  gate.resolve();
  await rendering;
  expect(network.stats().frames).toBe(1);
  expect(network.stats().vertices).toBe(20);
  await draw();
  expect(network.stats().frames).toBe(2);
  expect(network.stats().vertices).toBe(30);
  network.destroy();
  gpu.destroy();
});
it('takes a whole config, changing nothing when it repeats the one held', async () => {
  const gpu = await createGpu({ device: device().device }),
    { data } = fixture();
  const network = createNetwork(gpu, { ...data, vertexColor: [1, 0, 0, 1] });
  const invalidated = vi.fn(),
    off = invalidations(network)(invalidated);
  try {
    const held = network.config;
    // Built afresh the same way, as an application builds its config on every change.
    network.set(
      { ...fixture().data, source: data.source, vertexColor: [1, 0, 0, 1] },
      { replace: true },
    );
    expect(network.config).toBe(held);
    expect(invalidated).not.toHaveBeenCalled();
    network.set(data, { replace: true });
    expect(network.config).not.toHaveProperty('vertexColor');
    expect(network.config.vertices).toBe(held.vertices);
    expect(invalidated).toHaveBeenCalled();
  } finally {
    off();
    network.destroy();
    gpu.destroy();
  }
});

/**
 * Four buses a degree apart along latitude 30, joined in a line by branches, and three plants
 * without a position: the first feeds bus 0, the second bus 3, the third nothing.
 */
function stations() {
  const index = (type: string) => ({ source: 'stations', type, version: '1' }),
    rows = (count: number) => ({ kind: 'range' as const, offset: 0, count }),
    reference = (type: string, values: number[]) => ({
      kind: 'reference' as const,
      index: index(type),
      offset: 0,
      length: values.length,
      values: Uint32Array.from(values),
    }),
    to = (type: string) => ({ type: { kind: 'reference' as const, to: type } });
  const source = createData(
    {
      types: {
        bus: {
          fields: {
            location: { type: { kind: 'vector', items: 'float64', size: 2 }, geographic: true },
          },
        },
        plant: { fields: { output: { type: 'float32' } } },
        branch: { fields: { from: to('bus'), to: to('bus') } },
        feed: { fields: { plant: to('plant'), bus: to('bus') } },
      },
    },
    [
      {
        kind: 'rows',
        index: index('bus'),
        rows: rows(4),
        columns: {
          location: {
            kind: 'vector',
            size: 2,
            offset: 0,
            length: 4,
            values: {
              kind: 'numeric',
              offset: 0,
              length: 8,
              values: Float64Array.of(-100, 30, -99, 30, -98, 30, -97, 30),
            },
          },
        },
      },
      {
        kind: 'rows',
        index: index('plant'),
        rows: rows(3),
        columns: {
          output: { kind: 'numeric', offset: 0, length: 3, values: Float32Array.of(1, 2, 3) },
        },
      },
      {
        kind: 'rows',
        index: index('branch'),
        rows: rows(3),
        columns: { from: reference('bus', [0, 1, 2]), to: reference('bus', [1, 2, 3]) },
      },
      {
        kind: 'rows',
        index: index('feed'),
        rows: rows(2),
        columns: { plant: reference('plant', [0, 1]), bus: reference('bus', [0, 3]) },
      },
    ],
  );
  const config: NetworkConfig = {
    source,
    vertices: { bus: lanes('location'), plant: {} },
    edges: { branch: { ends: ['from', 'to'] }, feed: { ends: ['plant', 'bus'] } },
  };
  return { source, config, index };
}
/** A row's position as arrange placed it. */
function placedAt(
  positions: Awaited<ReturnType<typeof arrange>>,
  type: string,
  row: number,
): [number, number] {
  const { x, y } = positions[type];
  return [(x.values as NumericColumn).values[row], (y.values as NumericColumn).values[row]];
}
it('places vertices without a position by their edges, among geographic ones that stay', async () => {
  const gpu = await createGpu({ device: device().device }),
    { config } = stations();
  try {
    const placed = await arrange(gpu, config);
    expect([0, 1, 2, 3].map((row) => placedAt(placed, 'bus', row))).toEqual([
      [-100, 30],
      [-99, 30],
      [-98, 30],
      [-97, 30],
    ]);
    // Each fed plant sits about a branch from its bus, a branch being a degree.
    for (const [plant, bus] of [
      [0, 0],
      [1, 3],
    ]) {
      const [px, py] = placedAt(placed, 'plant', plant),
        [bx, by] = placedAt(placed, 'bus', bus);
      expect(Math.hypot(px - bx, py - by)).toBeGreaterThan(0.3);
      expect(Math.hypot(px - bx, py - by)).toBeLessThan(3);
    }
    // The plant nothing feeds packs below the rest, and every placement is the same.
    const lowest = Math.min(...[0, 1].map((row) => placedAt(placed, 'plant', row)[1]), 30);
    expect(placedAt(placed, 'plant', 2)[1]).toBeLessThan(lowest);
    expect(await arrange(gpu, config)).toEqual(placed);
    // Drawn, the positions stay geographic.
    const network = createNetwork(gpu, config);
    await gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
    });
    expect(network.projections.globe).toBe(true);
    expect(network.stats().vertices).toBe(7);
    network.destroy();
  } finally {
    gpu.destroy();
  }
});
it('places each row whose position reads no number among its positioned neighbours', async () => {
  const source = new GraphSource(25, 8);
  // The middle of the five by five grid, whose four neighbours sit 10 away.
  source.positions[24] = NaN;
  const data: NetworkData = {
      source: source.data,
      vertices: { node: lanes('location') },
      edges: { line: { ends: ['from', 'to'] } },
    },
    gpu = await createGpu({ device: device().device });
  try {
    const placed = await arrange(gpu, data),
      [x, y] = placedAt(placed, 'node', 12);
    expect(Math.hypot(x - (1e9 + 20), y - (1e9 + 20))).toBeLessThan(5);
    for (let row = 0; row < 25; row++)
      if (row !== 12)
        expect(placedAt(placed, 'node', row)).toEqual([
          source.positions[row * 2],
          source.positions[row * 2 + 1],
        ]);
    const network = createNetwork(gpu, {
        ...data,
        camera: { center: [1e9 + 20, 1e9 + 20], scale: 4, fit: false },
      }),
      surface = target(gpu),
      draw = (timeMs: number) =>
        gpu.render({ timeMs, views: [{ renderer: kit.rendererOf(network), target: surface }] }),
      node = (row: number) =>
        network.locate({ kind: 'vertex', source: source.data, index: source.index('node'), row })!;
    await draw(0);
    // Drawn where arrange places it: 4 pixels a unit, y down the screen.
    expect(node(12)[0] - node(13)[0]).toBeCloseTo((x - source.positions[26]) * 4, 3);
    expect(node(12)[1] - node(13)[1]).toBeCloseTo((source.positions[27] - y) * 4, 3);
    // Given a position, the row draws there.
    const values = source.positions.slice();
    values[24] = 1e9 + 25;
    network.set({
      vertices: {
        node: lanes({
          index: source.index('node'),
          rows: { kind: 'range', offset: 0, count: 25 },
          values: {
            kind: 'vector',
            size: 2,
            offset: 0,
            length: 25,
            values: { kind: 'numeric', offset: 0, length: 50, values },
          },
        }),
      },
    });
    await draw(1);
    expect(node(12)[0] - node(13)[0]).toBeCloseTo(-20);
    expect(node(12)[1]).toBeCloseTo(node(13)[1]);
    network.destroy();
  } finally {
    gpu.destroy();
  }
});
it('keeps placed vertices as the drawing changes, and places them anew for new layout options', async () => {
  const gpu = await createGpu({ device: device().device }),
    { config, source, index } = stations(),
    surface = target(gpu);
  const network = createNetwork(gpu, {
      ...config,
      edges: { branch: config.edges!.branch },
      camera: { center: [-98.5, 28], scale: 20, fit: false },
    }),
    draw = (timeMs: number) =>
      gpu.render({ timeMs, views: [{ renderer: kit.rendererOf(network), target: surface }] }),
    vertex = (type: string, row: number) =>
      network.locate({ kind: 'vertex', source, index: index(type), row })!;
  try {
    await draw(0);
    const loose = vertex('plant', 0);
    // New edges keep the plants where they were.
    network.set({ edges: config.edges });
    await draw(1);
    expect(vertex('plant', 0)).toEqual(loose);
    // New layout options place them anew, beside the buses they feed.
    network.set({ layout: { vertexGap: 0.5 } });
    await draw(2);
    const fed = vertex('plant', 0),
      bus = vertex('bus', 0);
    expect(fed).not.toEqual(loose);
    expect(Math.hypot(fed[0] - bus[0], fed[1] - bus[1])).toBeLessThan(30);
  } finally {
    network.destroy();
    gpu.destroy();
  }
});
