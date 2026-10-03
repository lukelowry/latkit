import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { bench } from 'vitest';
import { WebSocketServer } from 'ws';
import { acceptModel, connectModel, type ConnectedModel } from '@latkit/connect';
import {
  createData,
  textColumn,
  type Data,
  type DataBatch,
  type Index,
  type Model,
  type SampleBatch,
} from '@latkit/model';
import type { Schema } from '@latkit/model';
import { createGpu, kit, type Gpu, type TextRasterizer, type View } from '@latkit/gpu';
import { nullDevice } from './device.ts';

/** Every scalable benchmark runs at these sizes; the gate checks growth across them. */
export const sizes = [10_000, 100_000, 1_000_000];
/** Sampled frames in each grid: more than any benchmark runs, so playback always reaches a new one. */
export const frames = 32;

export const schema: Schema = {
  axis: { name: 'time', unit: 's' },
  types: {
    Bus: {
      fields: {
        position: { type: { kind: 'vector', items: 'float64', size: 2 } },
        load: { type: 'float32' },
        voltage: { type: 'float32', sampled: true },
      },
      spatial: { field: 'position', system: 'cartesian' },
    },
    Branch: {
      fields: {
        from: { type: { kind: 'reference', to: 'Bus' } },
        to: { type: { kind: 'reference', to: 'Bus' } },
      },
    },
  },
};
export const busIndex = (buses: number): Index => ({
  source: 'grid',
  type: 'Bus',
  version: String(buses),
});
const branchIndex = (buses: number): Index => ({
  source: 'grid',
  type: 'Branch',
  version: String(buses),
});

/**
 * Buses on a √n lattice, branches to their right and lower neighbours, `frames` of voltages. `ids`
 * names every row, as views that propose edits need.
 */
export function grid(buses: number, ids = false): Data {
  return createData(schema, batches(buses, ids));
}
/** Every batch of a grid: its rows, then each frame. */
export function batches(buses: number, ids = false): DataBatch[] {
  return [...topology(buses, ids), ...Array.from({ length: frames }, (_, f) => voltages(buses, f))];
}
/** The static rows of a grid. */
export function topology(buses: number, ids = false): DataBatch[] {
  const width = Math.ceil(Math.sqrt(buses)),
    from: number[] = [],
    to: number[] = [];
  for (let i = 0; i < buses; i++) {
    if ((i + 1) % width && i + 1 < buses) {
      from.push(i);
      to.push(i + 1);
    }
    if (i + width < buses) {
      from.push(i);
      to.push(i + width);
    }
  }
  const position = new Float64Array(buses * 2);
  for (let i = 0; i < buses; i++) {
    position[i * 2] = i % width;
    position[i * 2 + 1] = Math.floor(i / width);
  }
  const bus = busIndex(buses);
  return [
    {
      kind: 'rows',
      index: bus,
      rows: { kind: 'range', offset: 0, count: buses },
      ...(ids && { ids: names('bus', buses) }),
      columns: {
        position: {
          kind: 'vector',
          size: 2,
          offset: 0,
          length: buses,
          values: { kind: 'numeric', offset: 0, length: buses * 2, values: position },
        },
        load: numbers(Float32Array.from({ length: buses }, (_, i) => (i % 97) / 97)),
      },
    },
    {
      kind: 'rows',
      index: branchIndex(buses),
      rows: { kind: 'range', offset: 0, count: from.length },
      ...(ids && { ids: names('branch', from.length) }),
      columns: {
        from: {
          kind: 'reference',
          index: bus,
          offset: 0,
          length: from.length,
          values: Uint32Array.from(from),
        },
        to: {
          kind: 'reference',
          index: bus,
          offset: 0,
          length: to.length,
          values: Uint32Array.from(to),
        },
      },
    },
  ];
}
/** One frame of bus voltages at coordinate `frame`. */
export function voltages(buses: number, frame: number): SampleBatch {
  const values = Float32Array.from(
    { length: buses },
    (_, i) => 1 + Math.sin(i * 0.01 + frame * 0.2) / 20,
  );
  return {
    kind: 'samples',
    index: busIndex(buses),
    rows: { kind: 'range', offset: 0, count: buses },
    firstFrame: frame,
    coordinates: Float64Array.of(frame),
    columns: { voltage: { ...numbers(values), rowStride: 1, frameStride: buses } },
  };
}
/** A frame cut into row ranges of at most `rows`, as a producer publishes one that is too big. */
export function split(frame: SampleBatch, rows: number): SampleBatch[] {
  const column = frame.columns.voltage;
  return Array.from({ length: Math.ceil(column.length / rows) }, (_, b) => {
    const offset = b * rows,
      length = Math.min(rows, column.length - offset);
    return {
      ...frame,
      rows: { kind: 'range', offset, count: length },
      columns: {
        voltage: { ...column, values: column.values.subarray(offset, offset + length), length },
      },
    };
  });
}
/** A model connected over a local WebSocket, and accepted at the other end. */
export async function connected(monitor: Model['monitor']) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const accepted = new Promise<ConnectedModel>((resolve, reject) =>
    server.once('connection', (socket) => void acceptModel({ socket }).then(resolve, reject)),
  );
  const connection = await connectModel(
    { name: 'grid', schema, monitor },
    { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port },
  );
  const model = await accepted;
  return {
    model,
    async close() {
      await connection.close();
      await model.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
function names(prefix: string, count: number) {
  return textColumn(Array.from({ length: count }, (_, i) => prefix + i));
}
function numbers(values: Float32Array) {
  return { kind: 'numeric' as const, offset: 0, length: values.length, values };
}

/** Text with fixed metrics, so frames with labels need no canvas. */
const rasterizer: TextRasterizer = {
  rasterize: async (input) => ({
    width: 8,
    height: 8,
    coverage: new Uint8Array(64).fill(255),
    advance: input.text.length * 0.55,
    left: 0,
    top: -0.75,
    ascent: 0.75,
    descent: 0.2,
  }),
};
export function gpu(): Promise<Gpu> {
  return createGpu({
    device: nullDevice(),
    text: { rasterizer },
    budget: { cpuBytes: 512 * 1024 ** 2, gpuBytes: 2 * 1024 ** 3, entries: 100_000 },
  });
}

const surfaces = new WeakMap<Gpu, kit.RenderTarget>();
/** One offscreen 1280 × 720 frame of a view or renderer through the public render path. */
export async function draw(
  gpu: Gpu,
  view: View | kit.Renderer,
  at = 0,
  completion: 'progressive' | 'complete' = 'progressive',
): Promise<void> {
  let target = surfaces.get(gpu);
  if (!target) {
    const texture = gpu.device.createTexture({
      size: [1280, 720],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    target = {
      device: gpu.device,
      format: 'rgba8unorm',
      width: 1280,
      height: 720,
      texture: () => texture,
    };
    surfaces.set(gpu, target);
  }
  await gpu.render({
    timeMs: 0,
    completion,
    views: [
      {
        renderer: 'capture' in view ? view : kit.rendererOf(view),
        target,
        at,
        viewport: { width: 1280, height: 720, pixelRatio: 1 },
      },
    ],
  });
  await gpu.idle();
}

/** Drain an async iterable, as a consumer of blocks would. */
export async function drain(blocks: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _ of blocks) count++;
  return count;
}

/** Counters that only grow; the gate compares their change per run. */
const COUNTERS = [
  'queries',
  'queryHits',
  'uploads',
  'uploadedBytes',
  'uploadHits',
  'gpuCopiedBytes',
  'allocations',
  'submissions',
  'evictions',
  'stagedBytes',
] as const;
type Counters = Partial<Record<(typeof COUNTERS)[number], number>>;
const work: Record<string, Record<string, number>> = {};

/**
 * Benchmarks in one group. Each records its deterministic work per run, from `stats`, for the gate;
 * larger sizes run fewer iterations.
 */
export function suite(
  group: string,
  size: number,
  stats?: () => Counters,
  iterations = size >= 1_000_000 ? 6 : size >= 100_000 ? 12 : 24,
) {
  return (name: string, run: (i: number) => unknown): void => {
    let i = 0,
      runs = 0,
      before: Counters | undefined;
    bench(
      name,
      async () => {
        runs++;
        await run(i++);
      },
      {
        iterations,
        time: 0,
        warmupIterations: 2,
        warmupTime: 0,
        setup: (_task, mode) => {
          runs = 0;
          if (mode === 'run') before = stats?.();
        },
        teardown: (_task, mode) => {
          if (mode !== 'run' || !before || !stats) return;
          const after = stats();
          work[group + ' > ' + name] = Object.fromEntries(
            COUNTERS.filter((key) => after[key] !== undefined).map((key) => [
              key,
              round(((after[key] ?? 0) - (before![key] ?? 0)) / Math.max(1, runs)),
            ]),
          );
          record(group);
        },
      },
    );
  };
}
const round = (value: number) => Math.round(value * 1000) / 1000;
/** Each group writes its own file, so benchmark files may run in parallel. */
function record(group: string): void {
  const entries = Object.fromEntries(
    Object.entries(work).filter(([key]) => key.startsWith(group + ' > ')),
  );
  const directory = new URL('./.results/work/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    new URL(group.replace(/[^\w-]+/g, '-') + '.json', directory),
    JSON.stringify(entries, null, 2) + '\n',
  );
}
