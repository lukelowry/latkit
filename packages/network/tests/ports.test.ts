import { afterEach, expect, it, vi } from 'vitest';
import { createGpu } from '@latkit/gpu';
import type {
  EndpointsBlock,
  Index,
  Query,
  QueryBlock,
  QueryHeader,
  QueryOptions,
  Queryable,
  RowsBlock,
  Schema,
} from '@latkit/model';
import { createNetwork } from '../src/index.js';
import type { NetworkData } from '../src/data.js';
import { readGeometry, DEFAULT_LIMITS } from '../src/geometry/connectivity.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';

/** Buses as connections with positions, branches as components whose two ports sit on buses, and
 *  loads with one port, which a branch edge never reads. */
class GridSource implements Queryable {
  readonly version = 'v1';
  readonly positions = Float64Array.of(-100, 40, -99, 40, -98, 41, -97, 42);
  /** Each branch's buses; -1 leaves a port unwired. */
  readonly branches: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, -1],
  ];
  readonly loads: readonly number[] = [0, 2];
  readonly schema: Schema = {
    queries: ['rows', 'endpoints'],
    limits: { maxBlockBytes: 1 << 20 },
    components: {
      Branch: {
        fields: {},
        ports: {
          bus1: { direction: 'both', type: 'Bus' },
          bus2: { direction: 'both', type: 'Bus' },
        },
      },
      Load: { fields: {}, ports: { bus: { direction: 'both', type: 'Bus' } } },
    },
    connections: {
      Bus: {
        fields: { position: { type: { kind: 'vector', items: 'float64', size: 2 } } },
        roles: { terminal: { min: 0, direction: 'both' } },
        spatial: { field: 'position', system: 'EPSG:4326' },
      },
    },
  };
  index(type: string): Index {
    return { source: 'grid', type, version: 'v1' };
  }
  describe(): Promise<Schema> {
    return Promise.resolve(this.schema);
  }
  on(): () => void {
    return () => {};
  }
  retain(): Promise<Queryable> {
    return Promise.reject(new Error('Not retained'));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  query: Queryable['query'] = ((query: Query, options?: QueryOptions) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options?: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    options?.signal?.throwIfAborted();
    yield { kind: 'schema', version: this.version, schema: this.schema };
    if (query.kind === 'rows') yield this.rows(query.from, query.select);
    else if (query.kind === 'endpoints') yield this.endpoints();
    else throw new Error('Fixture query not implemented: ' + query.kind);
  }
  private rows(type: string, select: readonly string[]): RowsBlock {
    const count = type === 'Bus' ? 4 : type === 'Branch' ? this.branches.length : this.loads.length;
    return {
      kind: 'rows',
      version: this.version,
      index: this.index(type),
      rows: { kind: 'range', offset: 0, count },
      position: 0,
      columns: Object.fromEntries(
        select.map((field) => [
          field,
          {
            kind: 'vector',
            size: 2,
            offset: 0,
            length: count,
            values: { kind: 'numeric', offset: 0, length: count * 2, values: this.positions },
          },
        ]),
      ),
    };
  }
  /** Every bus's endpoints: the branch ends and the loads on it. */
  private endpoints(): EndpointsBlock {
    const ends: [type: number, row: number, port: number][][] = [[], [], [], []];
    this.branches.forEach(([a, b], row) => {
      if (a >= 0) ends[a]!.push([0, row, 0]);
      if (b >= 0) ends[b]!.push([0, row, 1]);
    });
    this.loads.forEach((bus, row) => ends[bus]!.push([1, row, 2]));
    const flat = ends.flat();
    const offsets = new Int32Array(5);
    ends.forEach((list, bus) => (offsets[bus + 1] = offsets[bus]! + list.length));
    return {
      kind: 'endpoints',
      version: this.version,
      index: this.index('Bus'),
      connections: Uint32Array.of(0, 1, 2, 3),
      offsets,
      firstEndpoint: new Uint32Array(4),
      totalEndpoints: Uint32Array.from(ends, (list) => list.length),
      componentIndexes: [this.index('Branch'), this.index('Load')],
      componentType: Uint32Array.from(flat, ([type]) => type),
      componentRow: Uint32Array.from(flat, ([, row]) => row),
      portNames: ['bus1', 'bus2', 'bus'],
      port: Uint32Array.from(flat, ([, , port]) => port),
      roleNames: ['terminal'],
      role: new Uint32Array(flat.length),
    };
  }
}

function data(source: Queryable): NetworkData {
  return {
    source,
    coordinates: 'geographic',
    vertices: { Bus: {} },
    edges: { Branch: { connectivity: { kind: 'ports', ports: ['bus1', 'bus2'] } } },
  };
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

afterEach(() => vi.restoreAllMocks());

it('draws a component between the connections its two ports sit on', async () => {
  const source = new GridSource();
  const gpu = await createGpu({ device: device().device });
  const surface = gpu.device.createTexture({
    size: [64, 64],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  let geometry!: Awaited<ReturnType<typeof readGeometry>>;
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
          async prepare(frame) {
            geometry = await readGeometry(data(source), frame, DEFAULT_LIMITS);
          },
          encode() {},
          destroy() {},
        },
      },
    ],
  });
  // The buses are the vertices, placed by their spatial field.
  expect(geometry.vertices.map(({ type, count }) => [type, count])).toEqual([['Bus', 4]]);
  // Every branch is an edge; the one with a port unwired has no segment.
  expect(geometry.edges.map(({ type, count }) => [type, count])).toEqual([['Branch', 4]]);
  expect(geometry.segmentCount).toBe(3);
  const vertex = { kind: 'vertex' as const, source, index: source.index('Bus'), row: 1 };
  const around = geometry.adjacency.neighborhood(vertex, data(source));
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

it('refuses ports that are not two distinct names', async () => {
  const gpu = await createGpu({ device: device().device });
  const source = new GridSource();
  for (const ports of [['bus1', 'bus1'], ['bus1']] as unknown as (readonly [string, string])[])
    expect(() =>
      createNetwork({
        gpu,
        data: { ...data(source), edges: { Branch: { connectivity: { kind: 'ports', ports } } } },
      }),
    ).toThrow('Port connectivity requires two distinct ports');
  gpu.destroy();
});
