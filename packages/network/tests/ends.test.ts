import { renderer as snapshotRenderer } from '../../gpu/tests/fixtures/public-render.js';
import { createData } from '@latkit/model';
import { afterEach, expect, it, vi } from 'vitest';
import { createGpu, type Gpu } from '@latkit/gpu';
import type {
  Column,
  Index,
  Query,
  QueryBlock,
  QueryHeader,
  QueryOptions,
  Data,
  DataBatch,
  Schema,
} from '@latkit/model';
import { createNetwork } from '../src/index.js';
import type { NetworkData } from '../src/data.js';
import { readGeometry, DEFAULT_LIMITS, type Geometry } from '../src/geometry/topology.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';

const lonlat = { kind: 'vector', items: 'float64', size: 2 } as const;
const bus = { type: { kind: 'reference', to: 'Bus' }, nullable: true } as const;

/** Buses placed by longitude/latitude, branches wired to two of them, and loads wired to one. */
class GridSource {
  readonly version = 'v1';
  readonly positions = Float64Array.of(-100, 40, -99, 40, -98, 41, -97, 42);
  /** Each branch's buses; -1 leaves an end unwired. */
  readonly branches: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, -1],
  ];
  /** Each load's bus and position. */
  readonly loads: readonly number[] = [0, 0, 2, 2, 2];
  readonly schema: Schema;
  constructor(system: 'geographic' | 'cartesian' = 'geographic') {
    this.schema = {
      limits: { maxBlockBytes: 1 << 20 },
      types: {
        Bus: { fields: { position: { type: lonlat } }, spatial: { field: 'position', system } },
        Branch: { fields: { bus1: bus, bus2: bus, rating: { type: 'float64' } } },
        Load: {
          fields: { bus, position: { type: lonlat } },
          spatial: { field: 'position', system: 'geographic' },
        },
      },
    };
  }
  index(type: string): Index {
    return { source: 'grid', type, version: 'v1' };
  }
  private cached?: Data;
  get data(): Data {
    if (this.cached) return this.cached;
    const batches: DataBatch[] = [];
    for (const [from, type] of Object.entries(this.schema.types))
      for (const block of this.blocks({ kind: 'rows', from, select: Object.keys(type.fields) }))
        if (block.kind === 'rows')
          batches.push({
            kind: 'rows',
            index: block.index,
            rows: block.rows,
            columns: block.columns,
          });
    return (this.cached = createData(this.schema, this.version, batches));
  }
  private *blocks(query: Query, options?: QueryOptions): Generator<QueryHeader | QueryBlock> {
    options?.signal?.throwIfAborted();
    yield { kind: 'schema', version: this.version, schema: this.schema };
    if (query.kind !== 'rows') throw new Error('Fixture query not implemented: ' + query.kind);
    const count =
      query.from === 'Bus' ? 4 : query.from === 'Branch' ? this.branches.length : this.loads.length;
    const column = (field: string): Column => {
      if (field === 'position') {
        const values =
          query.from === 'Bus'
            ? this.positions
            : Float64Array.from(this.loads.flatMap((b, i) => [-100 + b + i * 0.1, 39.5]));
        return {
          kind: 'vector',
          size: 2,
          offset: 0,
          length: count,
          values: { kind: 'numeric', offset: 0, length: count * 2, values },
        };
      }
      const rows =
        field === 'bus' ? this.loads : this.branches.map((ends) => ends[field === 'bus1' ? 0 : 1]);
      const validity = new Uint8Array(Math.ceil(count / 8));
      rows.forEach((row, i) => {
        if (row >= 0) validity[i >>> 3] |= 1 << (i & 7);
      });
      return {
        kind: 'reference',
        index: this.index('Bus'),
        offset: 0,
        length: count,
        values: Uint32Array.from(rows, (row) => Math.max(0, row)),
        validity,
      };
    };
    yield {
      kind: 'rows',
      version: this.version,
      index: this.index(query.from),
      rows: { kind: 'range', offset: 0, count },
      position: 0,
      columns: Object.fromEntries(query.select.map((field) => [field, column(field)])),
    };
  }
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
  return fake;
}
async function geometryOf(gpu: Gpu, data: NetworkData): Promise<Geometry> {
  const surface = gpu.device.createTexture({
    size: [64, 64],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  let geometry!: Geometry;
  await gpu.render({
    timeMs: 0,
    views: [
      {
        target: {
          device: gpu.device,
          width: 64,
          height: 64,
          format: 'rgba8unorm',
          texture: () => surface,
        },
        renderer: {
          ...snapshotRenderer(
            async (frame) => {
              geometry = await readGeometry(data, frame, DEFAULT_LIMITS);
            },
            () => {},
          ),
        },
      },
    ],
  });
  return geometry;
}
const branches = (source: GridSource): NetworkData => ({
  source: source.data,
  vertices: { Bus: {} },
  edges: { Branch: { ends: ['bus1', 'bus2'] } },
});

afterEach(() => vi.restoreAllMocks());

it('draws each row between the vertices its two references name', async () => {
  const source = new GridSource();
  const gpu = await createGpu({ device: device().device });
  const geometry = await geometryOf(gpu, branches(source));
  // Buses are placed by their spatial field, whose system makes the network geographic.
  expect(geometry.geographic).toBe(true);
  expect(geometry.vertices.map(({ type, count }) => [type, count])).toEqual([['Bus', 4]]);
  // Every branch is an edge; the one with an end unwired has no segment.
  expect(geometry.edges.map(({ type, count }) => [type, count])).toEqual([['Branch', 4]]);
  expect(geometry.segmentCount).toBe(3);
  const vertex = {
    kind: 'vertex' as const,
    source: source.data,
    index: source.index('Bus'),
    row: 1,
  };
  const around = geometry.adjacency.neighborhood(vertex, branches(source));
  expect(
    around
      .filter((item) => item.kind === 'vertex')
      .map((item) => item.row)
      .sort(),
  ).toEqual([0, 1, 2]);
  expect(
    around
      .filter((item) => item.kind === 'edge')
      .map((item) => item.row)
      .sort(),
  ).toEqual([0, 1]);
  gpu.destroy();
});

it('draws a net between the vertices whose references name it', async () => {
  const source = new GridSource();
  const gpu = await createGpu({ device: device().device });
  const data: NetworkData = { source: source.data, vertices: { Load: {} }, edges: { Bus: {} } };
  const geometry = await geometryOf(gpu, data);
  const [bank] = geometry.edges;
  // Bus 0 joins two loads, bus 2 three, and buses 1 and 3 none.
  expect([...bank.incidence.offsets]).toEqual([0, 2, 2, 5, 5]);
  expect([...bank.incidence.vertices]).toEqual([0, 1, 2, 3, 4]);
  expect(bank.stars).toBe(true);
  expect(geometry.segmentCount).toBe(1);
  const net = { kind: 'edge' as const, source: source.data, index: source.index('Bus'), row: 2 };
  expect(
    geometry.adjacency
      .neighborhood(net, data)
      .filter((item) => item.kind === 'vertex')
      .map((item) => item.row),
  ).toEqual([2, 3, 4]);
  gpu.destroy();
});

it('refuses ends that are not two distinct references to vertex types', async () => {
  const gpu = await createGpu({ device: device().device });
  const source = new GridSource();
  for (const ends of [['bus1', 'bus1'], ['bus1']] as unknown as (readonly [string, string])[])
    expect(() => createNetwork(gpu, { ...branches(source), edges: { Branch: { ends } } })).toThrow(
      'Edge ends must be two distinct fields',
    );
  expect(() =>
    createNetwork(gpu, {
      ...branches(source),
      edges: { Branch: { ends: ['bus1', 'bus2'], junction: 'x' } },
    }),
  ).toThrow('A junction centers a net');
  expect(() =>
    createNetwork(gpu, { ...branches(source), edges: { Bus: { bends: 'route' } } }),
  ).toThrow('Bends require ends');
  await expect(
    geometryOf(gpu, { ...branches(source), edges: { Branch: { ends: ['bus1', 'rating'] } } }),
  ).rejects.toThrow('must reference a vertex type');
  await expect(
    geometryOf(gpu, {
      ...branches(source),
      edges: { Branch: { ends: ['bus1', 'bus2'] } },
      vertices: { Load: {} },
    }),
  ).rejects.toThrow('must reference a vertex type');
  gpu.destroy();
});

it('reads the coordinate system from the drawn types, which must agree', async () => {
  const gpu = await createGpu({ device: device().device });
  const planar = new GridSource('cartesian');
  expect((await geometryOf(gpu, branches(planar))).geographic).toBe(false);
  await expect(
    geometryOf(gpu, { ...branches(planar), vertices: { Bus: {}, Load: {} } }),
  ).rejects.toThrow('disagree on their coordinate system');
  gpu.destroy();
});
