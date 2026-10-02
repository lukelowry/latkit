import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGpu, kit } from '@latkit/gpu';
import { createNetwork, type Network } from '../src/index.js';
import type { NetworkData } from '../src/data.js';
import { readGeometry, DEFAULT_LIMITS } from '../src/geometry/topology.js';
import { HOVER_EXHAUSTED, PickGeometry } from '../src/picking.js';
import { featureSource } from './paths-fixture.js';
import { GraphSource } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';

function fixture(count = 25, blockRows = 8) {
  const source = new GraphSource(count, blockRows);
  const data: NetworkData = {
    source: source.data,
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
/** Drive the pointer as input does. */
const pointer = (network: Network, point: readonly [number, number] | null) =>
  (network as unknown as { point(point: readonly [number, number] | null): void }).point(point);
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
  const position: kit.FieldValues = {
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
  network.set({ vertices: { node: { position } } });
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
      node: {
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
      },
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
  const network = createNetwork(gpu, { ...data, limits: { maxVertices: 10 } });
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
  expect(network.config).toBe(config);
  network.set({ camera: { projection: 'globe' } });
  expect(network.camera.projection).toBe('globe');
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
  });
  expect(network.projections.globe).toBe(false);
  expect(network.camera.projection).toBe('flat');
  network.destroy();
  expect(() => network.set({ showEdges: false })).toThrow('destroyed');
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

it('coalesces pointer movement into one committed hover search and keeps click picking explicit', async () => {
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

it('aborts automatic searches without a partial hit and latches across pointer and recording changes', async () => {
  const { data, source } = fixture(1000, 1000),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, {
    ...data,
    vertices: {
      node: {
        ...data.vertices.node,
        position: { x: 'x', y: 'y' },
        height: { field: 'z', domain: [0, 1] },
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
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
  await render();
  expect(nearest.mock.results[0].value).toBe(HOVER_EXHAUSTED);
  expect(projected.mock.calls.length).toBeLessThan(1000);
  expect(hover).not.toHaveBeenCalled();
  expect(network.stats()).toMatchObject({ hover: 'budget', pickingBytes: 0 });
  now.mockRestore();
  const invalidation = vi.fn();
  invalidations(network)(invalidation);
  for (let i = 0; i < 50; i++) pointer(network, [400 + i, 300]);
  expect(invalidation).not.toHaveBeenCalled();
  await render(1);
  expect(nearest).toHaveBeenCalledTimes(1);
  expect(network.stats().hover).toBe('budget');
  // An explicit policy update permits a new attempt; partial results never become hover.
  network.set({ hoverBudgetMs: 1000 });
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
  expect(invalidate).toHaveBeenCalledWith('refresh');
  network.destroy();
  gpu.destroy();
});

it('falls back to exact scanning when explicit indexes cannot fit the CPU budget', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const baseline = createNetwork(gpu, data),
    surface = target(gpu);
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(baseline), target: surface, at: 0 }],
  });
  const bytes = baseline.stats().geometryBytes;
  baseline.destroy();
  const network = createNetwork(gpu, { ...data, limits: { cpuBytes: bytes + 1 }, hover: 'off' });
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
    vertices: { node: { position: 'position' } },
    edges: {
      bend: { ends: ['from', 'to'], bends: 'points' },
      star: {},
      route: { ends: ['from', 'to'], curve: 'geodesic' },
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
  const hidden: kit.FieldValues = {
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

it('picks a geodesic arc at its visible arc-length midpoint in every projection', async () => {
  const source = featureSource(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, {
    source: source.data,
    vertices: { node: { position: 'position' } },
    edges: { route: { ends: ['from', 'to'], curve: 'geodesic' } },
    camera: { center: [-30, 5], scale: 4 },
    showVertices: false,
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

it('halos every selected item and its ends, expands shorthands, and reports camera changes', async () => {
  const { source, data } = fixture(),
    gpu = await createGpu({ device: device().device });
  const network = createNetwork(gpu, {
    ...data,
    vertices: { node: { position: 'location', color: { field: 'signal', colormap: 'viridis' } } },
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
