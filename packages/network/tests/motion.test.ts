import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGpu, gauge, icon, kit, shape, type MarkerImage } from '@latkit/gpu';
import {
  createData,
  failure,
  type Column,
  type Data,
  type FieldValues,
  type Schema,
} from '@latkit/model';
import { createNetwork, type Network, type NetworkConfig } from '../src/index.js';
import { readGeometry, DEFAULT_LIMITS, type EdgeBank } from '../src/geometry/topology.js';
import { LINE, channels } from '../src/rendering/fields.js';
import { project } from '../src/camera.js';
import type { PickGeometry } from '../src/picking.js';
import { GraphSource } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';
import { renderer as testRenderer } from '../../gpu/tests/fixtures/public-render.js';

type Fake = ReturnType<typeof fakeDevice>;
interface FakeBuffer {
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly destroyed: boolean;
}
/** A device whose passes record nothing, and whose copies and clears are listed. */
function device(): Fake & {
  copies: { from: FakeBuffer; to: FakeBuffer }[];
  clears: FakeBuffer[];
} {
  const fake = fakeDevice(),
    copies: { from: FakeBuffer; to: FakeBuffer }[] = [],
    clears: FakeBuffer[] = [];
  fake.device.createPipelineLayout = vi.fn(() => ({}) as GPUPipelineLayout);
  const original = fake.device.createCommandEncoder.bind(fake.device);
  fake.device.createCommandEncoder = vi.fn(() => {
    const encoder = original(),
      copy = encoder.copyBufferToBuffer.bind(encoder) as (...args: unknown[]) => void;
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      draw: vi.fn(),
      drawIndirect: vi.fn(),
      end: vi.fn(),
    };
    encoder.clearBuffer = vi.fn(
      (buffer: GPUBuffer) => void clears.push(buffer as unknown as FakeBuffer),
    );
    encoder.beginComputePass = vi.fn(() => pass as unknown as GPUComputePassEncoder);
    encoder.beginRenderPass = vi.fn(() => pass as unknown as GPURenderPassEncoder);
    encoder.copyBufferToBuffer = ((...args: unknown[]) => {
      copies.push({ from: args[0] as FakeBuffer, to: args[2] as FakeBuffer });
      copy(...args);
    }) as GPUCommandEncoder['copyBufferToBuffer'];
    return encoder;
  });
  return Object.assign(fake, { copies, clears });
}
/** The buffers made with a label. */
function made(fake: Fake, label: string): FakeBuffer[] {
  const calls = fake.native.createBuffer.mock;
  return calls.results
    .filter((_, i) => calls.calls[i][0].label === label)
    .map((result) => result.value as FakeBuffer);
}
/** A buffer's label, as it was made. */
function labelOf(fake: Fake, buffer: unknown): string | undefined {
  const made = fake.native.createBuffer.mock;
  const at = made.results.findIndex((result) => result.value === buffer);
  return at < 0 ? undefined : made.calls[at][0].label;
}
type Group = {
  readonly layout: { descriptor?: GPUBindGroupLayoutDescriptor };
  readonly entries: GPUBindGroupEntry[];
};
/** The latest of `values` that `test` takes. */
function last<T>(values: readonly T[], test: (value: T) => boolean): T | undefined {
  for (let i = values.length - 1; i >= 0; i--) if (test(values[i])) return values[i];
  return undefined;
}
const groups = (fake: Fake) =>
  fake.native.createBindGroup.mock.calls.map(([descriptor]) => descriptor as unknown as Group);
/** The network's uniforms as its latest frame wrote them, by word. */
function uniforms(fake: Fake): { readonly f: Float32Array; readonly u: Uint32Array } {
  // The surface binds the uniforms alone, to its vertex and fragment stages.
  const surface = last(groups(fake), (group) => {
    const entries = [...(group.layout.descriptor?.entries ?? [])];
    return entries.length === 1 && entries[0].visibility === 3;
  })!;
  const { buffer, offset = 0 } = surface.entries[0].resource as GPUBufferBinding,
    bytes = (buffer as unknown as FakeBuffer).bytes.slice(offset, offset + 288);
  return { f: new Float32Array(bytes.buffer), u: new Uint32Array(bytes.buffer) };
}
/** Words of `Uniforms`, as the painter writes them. */
const SHIFT = 56,
  EASE = 58,
  DT = 59,
  GROWN = 66,
  GROWTH = 68;
const NONE = 0xffffffff;
function target(gpu: Awaited<ReturnType<typeof createGpu>>) {
  const texture = gpu.device.createTexture({
    size: [400, 300],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    device: gpu.device,
    width: 400,
    height: 300,
    format: 'rgba8unorm' as const,
    texture: () => texture,
  };
}
async function view(
  fake: Fake,
  config: (source: GraphSource) => Partial<NetworkConfig> = () => ({}),
  geographic = false,
) {
  const gpu = await createGpu({ device: fake.device }),
    source = new GraphSource(25, 8, geographic),
    network = createNetwork(gpu, {
      source: source.data,
      vertices: { node: { x: 'location', y: { field: 'location', component: 1 } } },
      edges: { line: { ends: ['from', 'to'] } },
      motion: 'full',
      animationMs: 300,
      ...config(source),
    } as NetworkConfig),
    surface = target(gpu);
  const render = (timeMs: number, presented = true) =>
    gpu.render({
      timeMs,
      views: [{ renderer: kit.rendererOf(network), target: surface, at: 0, presented }],
    });
  return { gpu, source, network, render };
}
const animating = (network: Network) => (network as unknown as { animating: boolean }).animating;
/** Drive the pointer as input does. */
const pointer = (network: Network, point: readonly [number, number] | null) =>
  (network as unknown as { pointer(point: readonly [number, number] | null): void }).pointer(point);
afterEach(() => vi.restoreAllMocks());
beforeEach(() => void fakeDevice());

it('eases an animated change from what was drawn, on the GPU, for as long as the style says', async () => {
  const fake = device(),
    { gpu, network, render } = await view(fake);
  await render(0);
  expect(uniforms(fake).f[EASE]).toBe(0);
  network.set({ vertices: { node: { radiusPx: 7 } } }, { animate: true });
  fake.copies.length = 0;
  await render(100);
  // Each bank that drew is copied as the transition begins: the vertices, then the lines.
  expect(fake.copies.map(({ to }) => labelOf(fake, to))).toEqual([
    'network transition start',
    'network transition start',
  ]);
  expect(fake.copies.every(({ from, to }) => from.size === to.size)).toBe(true);
  expect(uniforms(fake).f[EASE]).toBe(1);
  const previous = (group: Group) =>
    labelOf(
      fake,
      (group.entries.find((entry) => entry.binding === 3)?.resource as GPUBufferBinding).buffer,
    );
  const computeGroups = () =>
    groups(fake).filter((group) => group.entries.length === 4 && group.entries[3].binding === 3);
  expect(computeGroups().slice(-2).map(previous)).toEqual([
    'network transition start',
    'network transition start',
  ]);
  await render(250);
  expect(fake.copies).toHaveLength(2);
  expect(uniforms(fake).f[EASE]).toBeCloseTo(0.125);
  expect(animating(network)).toBe(true);
  // An export draws every value where it is going.
  await render(260, false);
  expect(uniforms(fake).f[EASE]).toBe(0);
  await render(400);
  expect(uniforms(fake).f[EASE]).toBe(0);
  expect(animating(network)).toBe(false);
  // At rest a bank eases from nothing, and what the transition eased from is let go.
  expect(computeGroups().slice(-2).map(previous)).toEqual([
    'network empty binding',
    'network empty binding',
  ]);
  expect(made(fake, 'network transition start').every((buffer) => buffer.destroyed)).toBe(true);
  // Without `animate`, a change steps.
  network.set({ vertices: { node: { radiusPx: 5 } } });
  await render(500);
  expect(fake.copies).toHaveLength(2);
  expect(uniforms(fake).f[EASE]).toBe(0);
  // Reduced motion steps too.
  network.set({ motion: 'reduce' });
  network.set({ vertices: { node: { radiusPx: 6 } } }, { animate: true });
  await render(600);
  expect(fake.copies).toHaveLength(2);
  network.destroy();
  gpu.destroy();
});

it('eases rows new to the drawing in from nothing, and steps when the budget cannot hold the start', async () => {
  const fake = device(),
    { gpu, network, render } = await view(fake);
  await render(0);
  // A marker that reads inputs makes the vertices' records anew: they ease in, as the lines ease on.
  network.set({ vertices: { node: { marker: gauge({ fill: 'signal' }) } } }, { animate: true });
  await render(100);
  expect(fake.copies.map(({ to }) => labelOf(fake, to))).toEqual(['network transition start']);
  expect(fake.clears.map((buffer) => labelOf(fake, buffer))).toEqual(['network transition start']);
  expect(uniforms(fake).f[EASE]).toBe(1);
  await render(500);
  // A start the GPU budget cannot hold steps: nothing is copied and nothing eases.
  const buffer = gpu.buffer.bind(gpu);
  vi.spyOn(gpu, 'buffer').mockImplementation((descriptor) => {
    if (descriptor.label === 'network transition start')
      throw failure('resource-limit', 'GPU budget exceeded by live or in-flight resources');
    return buffer(descriptor);
  });
  fake.copies.length = 0;
  network.set({ vertices: { node: { radiusPx: 9 } } }, { animate: true });
  await render(600);
  expect(fake.copies).toHaveLength(0);
  expect(uniforms(fake).f[EASE]).toBe(0);
  expect(animating(network)).toBe(false);
  network.destroy();
  gpu.destroy();
});

it('eases around the globe the short way', async () => {
  const fake = device(),
    { gpu, source, network, render } = await view(
      fake,
      () => ({
        camera: { projection: 'globe', center: [180, 0], scale: 200, fit: false },
      }),
      true,
    );
  void source;
  await render(0);
  network.set({ camera: { center: [-179, 0] } });
  await render(10);
  // The camera crosses the seam at once while the vertices ease from where they drew.
  network.set({ camera: { center: [179, 0] } });
  network.set({ vertices: { node: { radiusPx: 6 } } }, { animate: true });
  await render(20);
  // The shift the snapshot eases across is two degrees, not three hundred and fifty-eight.
  expect(uniforms(fake).f[SHIFT]).toBeCloseTo(2, 3);
  network.destroy();
  gpu.destroy();
});

it('moves flow by the time between presented frames, and holds it still under reduced motion', async () => {
  const fake = device(),
    { gpu, network, render } = await view(fake, () => ({
      edges: { line: { ends: ['from', 'to'], flowPx: 20 } },
    }));
  await render(1000);
  expect(uniforms(fake).f[DT]).toBe(0);
  await render(1050);
  expect(uniforms(fake).f[DT]).toBeCloseTo(0.05);
  expect(animating(network)).toBe(true);
  // An export moves nothing; a stall moves a tenth of a second at most.
  await render(1060, false);
  expect(uniforms(fake).f[DT]).toBe(0);
  await render(3000);
  expect(uniforms(fake).f[DT]).toBeCloseTo(0.1);
  network.set({ motion: 'reduce' });
  await render(3050);
  expect(uniforms(fake).f[DT]).toBe(0);
  expect(animating(network)).toBe(false);
  network.destroy();
  gpu.destroy();
});

it('grows the hovered vertex, eased, and lets it go the same way', async () => {
  const fake = device(),
    { gpu, source, network, render } = await view(fake, () => ({ hover: 'on' }));
  await render(0);
  const point = network.locate({
    kind: 'vertex',
    source: source.data,
    index: source.index('node'),
    row: 12,
  })!;
  pointer(network, point);
  await render(10);
  expect([...uniforms(fake).u.subarray(GROWN, GROWN + 2)]).toEqual([12, NONE]);
  expect(uniforms(fake).f[GROWTH]).toBe(0);
  expect(animating(network)).toBe(true);
  await render(90);
  expect(uniforms(fake).f[GROWTH]).toBeCloseTo(1 - 0.5 ** 3);
  await render(200);
  expect(uniforms(fake).f[GROWTH]).toBe(1);
  expect(animating(network)).toBe(false);
  pointer(network, null);
  await render(210);
  expect([...uniforms(fake).u.subarray(GROWN, GROWN + 2)]).toEqual([NONE, 12]);
  expect(uniforms(fake).f[GROWTH + 1]).toBe(1);
  await render(400);
  expect(uniforms(fake).f[GROWTH + 1]).toBe(0);
  expect(animating(network)).toBe(false);
  network.destroy();
  gpu.destroy();
});

/** Three stations, two lines joining the first two each way and a third, and one onward. */
function parallel(): Data {
  const index = (type: string) => ({ source: 'parallel', type, version: '1' });
  const reference = (values: number[]): Column => ({
    kind: 'reference',
    index: index('Station'),
    offset: 0,
    length: values.length,
    values: Uint32Array.from(values),
  });
  return createData(
    {
      types: {
        Station: { fields: { location: { type: { kind: 'vector', items: 'float64', size: 2 } } } },
        Line: {
          fields: {
            from: { type: { kind: 'reference', to: 'Station' } },
            to: { type: { kind: 'reference', to: 'Station' } },
          },
        },
      },
    },
    [
      {
        kind: 'rows',
        index: index('Station'),
        rows: { kind: 'range', offset: 0, count: 3 },
        columns: {
          location: {
            kind: 'vector',
            size: 2,
            offset: 0,
            length: 3,
            values: {
              kind: 'numeric',
              offset: 0,
              length: 6,
              values: Float64Array.of(0, 0, 10, 0, 20, 0),
            },
          },
        },
      },
      {
        kind: 'rows',
        index: index('Line'),
        rows: { kind: 'range', offset: 0, count: 4 },
        columns: { from: reference([0, 1, 0, 1]), to: reference([1, 0, 1, 2]) },
      },
    ],
  );
}

it('reads each edge’s lane among parallel ones as a channel, once edges draw apart', async () => {
  const source = parallel(),
    fake = device(),
    gpu = await createGpu({ device: fake.device }),
    config = {
      source,
      vertices: { Station: { x: 'location', y: { field: 'location', component: 1 } } },
      edges: { Line: { ends: ['from', 'to'] as const } },
    };
  let lanes: FieldValues | undefined,
    bank!: EdgeBank,
    bent = -1;
  await gpu.render({
    timeMs: 0,
    views: [
      {
        target: target(gpu),
        renderer: testRenderer(async (frame) => {
          const geometry = await readGeometry(config, frame.reader, DEFAULT_LIMITS);
          bank = geometry.edges[0];
          lanes = geometry.adjacency.laneValues(bank, config);
          // A type with bends follows its own routes: it takes no lanes.
          bent = geometry.adjacency.lanes({
            ...config,
            edges: { Line: { ends: ['from', 'to'], bends: 'route' } },
          }).size;
        }),
      },
    ],
  });
  // Spread about 0 and signed by direction, so the line drawn back stays apart; alone reads 0.
  const values = lanes!.values as { values: Float32Array };
  expect([...values.values].map((v) => v + 0)).toEqual([-1, 0, 1, 0]);
  expect(lanes).toMatchObject({ index: bank.index, rows: bank.rows });
  expect(bent).toBe(0);
  const bound = channels(config.edges.Line, LINE, lanes);
  expect(Object.values(bound.fields)).toContain(lanes);
  expect(channels(config.edges.Line, LINE).channels.lane?.field).toBeUndefined();
  // The line page's lane reads a field only once edges draw apart: its slot names one.
  const laneSlot = async (edgeSpacingPx: number) => {
    const network = createNetwork(gpu, { ...config, edgeSpacingPx, canvas: undefined });
    await gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
    });
    // The vertex page's slot, then the line page's; its seventh channel is the lane.
    const slots = (network as unknown as { painter: { slots: Uint32Array } }).painter.slots,
      slot = slots[64 + 8 + 6 * 8 + 4];
    network.destroy();
    return slot;
  };
  expect(await laneSlot(0)).toBe(NONE);
  expect(await laneSlot(6)).not.toBe(NONE);
  gpu.destroy();
});

it('reads a marked bank’s inputs with its vertices, after their records, stepping only what steps', async () => {
  const fake = device(),
    image = {
      width: 1,
      height: 1,
      data: Uint8ClampedArray.of(255, 0, 0, 255),
    } as unknown as MarkerImage,
    { gpu, network, render } = await view(fake, () => ({
      vertices: {
        node: {
          x: 'location',
          y: { field: 'location', component: 1 },
          marker: icon({ images: [image], image: 'signal' }),
        },
      },
    }));
  await render(0);
  const marked = last(groups(fake), (group) => group.entries.length === 6)!;
  const output = marked.entries.find((entry) => entry.binding === 2)!.resource as GPUBufferBinding,
    bank = marked.entries.find((entry) => entry.binding === 5)!.resource as GPUBufferBinding;
  // Five vec4 of records and two of inputs a row.
  expect((output.buffer as unknown as FakeBuffer).size).toBe(25 * (80 + 32));
  const words = new Uint32Array(
    (bank.buffer as unknown as FakeBuffer).bytes.slice(bank.offset ?? 0, (bank.offset ?? 0) + 8)
      .buffer,
  );
  expect([...words]).toEqual([25, 1]);
  expect(
    fake.native.createComputePipelineAsync.mock.calls.some(
      ([descriptor]) => descriptor.compute.entryPoint === 'marked_vertices',
    ),
  ).toBe(true);
  // A marker without inputs draws with the plain pass, its records alone.
  const before = groups(fake).length;
  network.set({ vertices: { node: { marker: shape('diamond') } } });
  await render(10);
  const after = groups(fake).slice(before);
  expect(after.some((group) => group.entries.length === 6)).toBe(false);
  expect(after.some((group) => group.entries.length === 4)).toBe(true);
  network.destroy();
  gpu.destroy();
});

it('picks a geodesic edge in its lane, which follows the curve as drawing does', async () => {
  const index = (type: string) => ({ source: 'routes', type, version: '1' });
  const reference = (values: number[]): Column => ({
    kind: 'reference',
    index: index('City'),
    offset: 0,
    length: values.length,
    values: Uint32Array.from(values),
  });
  const source = createData(
    {
      types: {
        City: {
          fields: {
            at: { type: { kind: 'vector', items: 'float64', size: 2 }, geographic: true },
          },
        },
        Route: {
          fields: {
            from: { type: { kind: 'reference', to: 'City' } },
            to: { type: { kind: 'reference', to: 'City' } },
          },
        },
      },
    },
    [
      {
        kind: 'rows',
        index: index('City'),
        rows: { kind: 'range', offset: 0, count: 2 },
        columns: {
          at: {
            kind: 'vector',
            size: 2,
            offset: 0,
            length: 2,
            values: { kind: 'numeric', offset: 0, length: 4, values: Float64Array.of(0, 0, 10, 0) },
          },
        },
      },
      {
        kind: 'rows',
        index: index('Route'),
        rows: { kind: 'range', offset: 0, count: 2 },
        columns: { from: reference([0, 0]), to: reference([1, 1]) },
      },
    ],
  );
  const gpu = await createGpu({ device: device().device }),
    network = createNetwork(gpu, {
      source,
      vertices: { City: { x: 'at', y: { field: 'at', component: 1 } } },
      edges: { Route: { ends: ['from', 'to'], route: 'geodesic' } },
      edgeSpacingPx: 20,
      markers: false,
      camera: { projection: 'flat', center: [5, 0], scale: 30, fit: false },
    });
  await gpu.render({
    timeMs: 0,
    views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
  });
  // Along the equator the curve runs straight across: lanes sit 10 px above and below it.
  const rowAt = async (y: number) =>
    (await network.pick([200, y], { radiusPx: 3 })).find((hit) => hit.kind === 'edge')?.row;
  expect(await rowAt(140)).toBe(0);
  expect(await rowAt(160)).toBe(1);
  expect(await rowAt(150)).toBeUndefined();
  network.destroy();
  gpu.destroy();
});

const stations: Schema = {
  types: {
    Station: {
      fields: { at: { type: { kind: 'vector', items: 'float64', size: 2 }, geographic: true } },
    },
  },
};
/** One station at a longitude on the equator, geographic, in the same row space every time. */
function station(lon: number): Data {
  const index = { source: 'station', type: 'Station', version: '1' };
  return createData(stations, [
    {
      kind: 'rows',
      index,
      rows: { kind: 'range', offset: 0, count: 1 },
      columns: {
        at: {
          kind: 'vector',
          size: 2,
          offset: 0,
          length: 1,
          values: { kind: 'numeric', offset: 0, length: 2, values: Float64Array.of(lon, 0) },
        },
      },
    },
  ]);
}

it('places labels as the GPU eases what they name: in the data, the short way round a globe', async () => {
  const gpu = await createGpu({ device: device().device }),
    network = createNetwork(gpu, {
      source: station(179),
      vertices: { Station: { x: 'at', y: { field: 'at', component: 1 } } },
      camera: { projection: 'globe', center: [180, 0], scale: 200, fit: false },
    });
  type Shown = {
    readonly picking: PickGeometry;
    readonly geometry: { readonly vertices: readonly Parameters<PickGeometry['projected']>[0][] };
    readonly camera: Parameters<typeof project>[0];
    readonly viewport: Parameters<typeof project>[1];
    readonly height: number;
  };
  const shown = () => (network as unknown as { shown: Shown }).shown;
  const draw = (timeMs: number) =>
    gpu.render({
      timeMs,
      views: [{ renderer: kit.rendererOf(network), target: target(gpu), at: 0 }],
    });
  await draw(0);
  const before = shown().picking;
  network.set({ source: station(-179) });
  await draw(10);
  const { picking, geometry, camera, viewport, height } = shown(),
    eased = picking
      .easedFrom(before, 0.5, true)
      .projected(geometry.vertices[0], 0, camera, viewport, height),
    seam = project(camera, viewport, 180, 0, 0);
  expect(eased.x).toBeCloseTo(seam.x, 3);
  expect(eased.y).toBeCloseTo(seam.y, 3);
  network.destroy();
  gpu.destroy();
});
