import { loadLatkit, field, type Scene } from 'latkit';
import wasmUrl from 'latkit/wasm?url';
import workerUrl from 'latkit/worker?url';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function destroyed(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    check(
      String(error).includes('destroyed'),
      `unexpected disposed-handle error: ${String(error)}`,
    );
    return;
  }
  throw new Error('a destroyed handle remained usable');
}

async function until(condition: () => boolean): Promise<void> {
  const end = performance.now() + 30_000;
  while (!condition()) {
    check(performance.now() < end, 'rendering did not settle');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const scene: Scene = {
  space: { plane: { grid: 'off' } },
  theme: 'dark',
  ease: 0,
  marks: [
    {
      vertices: {
        of: ['grid', 'Bus'],
        position: ['x', 'y'],
        radius: field('radius'),
        color: '#ff0000',
      },
    },
  ],
};

async function run(custom: boolean, compiled: boolean) {
  let blob: string | undefined;
  let createdWorkers = 0;
  if (custom) {
    blob = URL.createObjectURL(
      new Blob([await (await fetch(workerUrl)).text()], { type: 'text/javascript' }),
    );
  }
  const createWorker = () => {
    createdWorkers++;
    return new Worker(blob!);
  };
  const started = performance.now();
  const source = compiled ? await WebAssembly.compileStreaming(fetch(wasmUrl)) : wasmUrl;
  const loading = loadLatkit(
    custom ? { wasm: source, createWorker } : compiled ? { wasm: source } : undefined,
  );
  check(loading === loadLatkit(), 'concurrent loads must share their promise');
  const kit = await loading;
  const initialized = performance.now();
  check(kit === (await loadLatkit()), 'subsequent loads must reuse the API');
  let conflict = false;
  try {
    await loadLatkit({ wasm: '/a-different-module.wasm' });
  } catch {
    conflict = true;
  }
  check(conflict, 'conflicting configuration must reject');
  check(createdWorkers === 0, 'loading must not create workers');

  const { Data, Patch, Gpu } = kit;
  const empty = new Data('grid');
  const patch = new Patch().put('Bus', 1, { x: [0], y: [0], radius: [12] });
  const data = empty.apply(patch);
  patch.destroy();
  patch.destroy();
  empty.destroy();
  empty.destroy();
  destroyed(() => empty.name);
  const decoded = Data.fromBytes(data.toBytes());
  const gpu = await Gpu.create();
  const secondGpu = await Gpu.create();
  const deviceReady = performance.now();
  const canvas = (id: string) => document.querySelector<HTMLCanvasElement>(`#${id}`)!;
  const first = gpu.view(canvas('first'), scene);
  const second = gpu.view(canvas('second'), scene);
  const third = secondGpu.view(canvas('third'), scene);
  for (const view of [first, second, third]) {
    view.on('error', (error) => {
      throw error;
    });
    view.setData(decoded);
  }
  decoded.destroy(); // views retain the data
  await until(() =>
    [first, second, third].every((view) => view.stats.frames > 0 && view.stats.drawn === 1),
  );
  const firstFrame = performance.now();
  const hits = await first.pick([128, 128], 8);
  check(
    hits.some((hit) => hit.row.table === 'Bus'),
    'GPU picking must see the rendered vertex',
  );

  let ticks = 0;
  const stop = gpu.on('frame', () => ticks++);
  await until(() => ticks > 0);
  first.destroy();
  first.destroy();
  destroyed(() => first.stats);
  check(second.stats.drawn === 1, 'destroying one view must preserve its sibling');
  const pending = Promise.allSettled([
    second.pick([128, 128], 8),
    second.locate({ data: 'grid', table: 'Bus', id: 0 }),
  ]);
  gpu.destroy();
  gpu.destroy();
  stop();
  stop();
  destroyed(() => second.stats);
  destroyed(() => gpu.view(canvas('first'), scene));
  for (const answer of await pending) {
    check(answer.status === 'rejected', 'destroying the view must cancel pending queries');
    const error: unknown = answer.reason;
    check(
      error instanceof Error && 'code' in error && error.code === 'cancelled',
      'query must reject with cancellation',
    );
  }
  check(data.ids('Bus').length === 1, 'GPU cleanup must preserve independent data');
  const stoppedTicks = ticks;
  let otherTicks = 0;
  const stopOther = secondGpu.on('frame', () => otherTicks++);
  await until(() => otherTicks >= 3);
  check(ticks === stoppedTicks, 'GPU cleanup must stop its frame listeners');
  stopOther();
  stopOther();
  check(third.stats.drawn === 1, 'other GPUs must remain usable');

  // Exercise the real worker, including its standalone Blob deployment in the custom case.
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    }),
  );
  const places = await kit.geojson('places', bytes);
  check(places.ids('points').length === 1, 'worker must decode GeoJSON');
  if (custom) check(createdWorkers > 0, 'custom worker factory must be used');
  places.destroy();
  secondGpu.destroy();
  data.destroy();
  const transient = await Gpu.create();
  await new Promise<void>((resolve) => {
    transient.on('frame', () => {
      transient.destroy();
      resolve();
    });
  });
  if (blob) URL.revokeObjectURL(blob);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  return {
    initializationMs: initialized - started,
    gpuMs: deviceReady - initialized,
    firstFrameMs: firstFrame - started,
  };
}

Object.assign(window, { packageConsumer: { run } });
