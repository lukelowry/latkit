import { load, field, Data, Gpu, Patch, Shot, type Scene } from 'latkit';
import { quickstart } from './quickstart';
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
      error instanceof Error && 'code' in error && error.code === 'destroyed',
      `unexpected error from a destroyed handle: ${String(error)}`,
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
        position: ['$x', '$y'],
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
  const worker = () => {
    createdWorkers++;
    return new Worker(blob!);
  };
  const started = performance.now();
  const source = compiled ? await WebAssembly.compileStreaming(fetch(wasmUrl)) : wasmUrl;
  const loading = load(custom ? { wasm: source, worker } : compiled ? { wasm: source } : undefined);
  check(loading === load(), 'concurrent loads must share their promise');
  await loading;
  const initialized = performance.now();
  check(load() === loading, 'later loads must reuse the first');
  let conflict = false;
  try {
    await load({ wasm: '/a-different-module.wasm' });
  } catch {
    conflict = true;
  }
  check(conflict, 'conflicting configuration must reject');
  check(createdWorkers === 0, 'loading must not create workers');

  const data = new Data('grid').apply(
    new Patch('grid').replace('Bus', { count: 1 }, { x: [0], y: [0], radius: [12] }),
  );
  const empty = new Data('grid');
  empty.destroy();
  empty.destroy();
  destroyed(() => empty.name);
  const decoded = await Data.read(data.toBytes());
  const kept = decoded.snapshot();

  // Queries read data back, and patches apply from a stream split into small chunks.
  const grid = new Data('grid').apply(
    new Patch()
      .axis('time', 's')
      .replace('Branch', [7, 8, 9], { loading: [40, 120, 95] })
      .append('Branch', [0, 1, 2], { flow: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9) }),
  );
  const hot = grid.query({
    of: 'Branch',
    filter: field('loading').gt(90),
    select: { flow: '$flow' },
    at: 1,
  });
  check(hot.ids.join() === '8,9' && hot.total === 2, 'a query filters');
  check((hot.fields.flow as Float64Array)[0] === 5, 'a query reads samples at its coordinate');
  const sent = [
    new Patch().set('Branch', [7], { loading: [1] }),
    new Patch().remove('Branch', [8]),
  ].flatMap((p) => [...p.toBytes()]);
  const pieces = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < sent.length; at += 3)
        controller.enqueue(Uint8Array.from(sent.slice(at, at + 3)));
      controller.close();
    },
  });
  for await (const next of Patch.stream(pieces)) grid.apply(next);
  check(
    grid.query({ of: 'Branch' }).ids.join() === '7,9' && grid.get('Branch', 7, 'loading') === 1,
    'patches stream',
  );
  grid.destroy();
  const gpu = await Gpu.create();
  const secondGpu = await Gpu.create();
  const deviceReady = performance.now();
  const canvas = (id: string) => document.querySelector<HTMLCanvasElement>(`#${id}`)!;
  const first = gpu.view(scene);
  const second = gpu.view(scene);
  const third = secondGpu.view(scene);
  gpu.canvas(canvas('first'), { layout: [{ view: first }] });
  gpu.canvas(canvas('second'), { layout: [{ view: second }] });
  secondGpu.canvas(canvas('third'), { layout: [{ view: third }] });
  // A view that no canvas shows still draws in shots.
  const headless = gpu.view(scene);
  for (const view of [first, second, third, headless]) {
    view.on('error', (error) => {
      throw error;
    });
    view.sources = view === third ? [kept] : [decoded];
  }
  decoded.destroy(); // the views keep their own reference to the dataset
  kept.destroy();
  await until(() =>
    [first, second, third].every((view) => view.stats.frames > 0 && view.stats.drawn === 1),
  );
  const firstFrame = performance.now();
  const picture = await new Shot([64, 64], { layout: [{ view: headless }] }).image();
  check(picture.width === 64 && picture.height === 64, 'a view without a canvas draws in a shot');
  const png = await picture.encode('png');
  const jpeg = await picture.encode('jpeg', { quality: 80 });
  const webp = await picture.encode('webp');
  check(
    png[1] === 0x50 && jpeg[0] === 0xff && webp[0] === 0x52,
    'pictures write as PNG, JPEG, and WebP',
  );
  picture.destroy();
  let videoTested = false;
  if (
    typeof VideoEncoder === 'function' &&
    (
      await VideoEncoder.isConfigSupported({
        codec: 'avc1.42e01f',
        width: 64,
        height: 64,
        framerate: 30,
        bitrate: 100_000,
        avc: { format: 'annexb' },
      })
    ).supported
  ) {
    videoTested = true;
    const chunks: Uint8Array[] = [];
    const output = new WritableStream<Uint8Array>({
      write(bytes) {
        chunks.push(bytes);
      },
    });
    const video = new Shot([64, 64], { layout: [{ view: headless }] }).video({ fps: 30, output });
    await video.record((time) => time < 0.1);
    check(video.frames === 3 && !output.locked, 'video retains counters and releases its output');
    check(
      chunks.some((bytes) => new TextDecoder().decode(bytes).includes('ftyp')),
      'video writes an MP4 header',
    );
    const cancelledOutput = new WritableStream<Uint8Array>();
    const cancelled = new Shot([64, 64], { layout: [{ view: headless }] }).video({
      fps: 30,
      output: cancelledOutput,
    });
    const pending = cancelled.frame();
    const settled = Promise.allSettled([pending]);
    await Promise.resolve();
    await cancelled.abort('consumer cancellation');
    check((await settled)[0].status === 'rejected', 'cancellation interrupts the WASM frame');
    check(!cancelledOutput.locked, 'cancelled video releases the writer');
    const restored = await new Shot([64, 64], { layout: [{ view: headless }] }).image();
    restored.destroy();
  }
  headless.destroy();
  check(
    (() => {
      try {
        gpu.canvas(document.createElement('canvas'), { layout: [{ view: second }] });
        return false;
      } catch {
        return true;
      }
    })(),
    'a view shows in one canvas at a time',
  );
  const hits = await first.pick([128, 128], { radius: 8 });
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
    second.pick([128, 128], { radius: 8 }),
    second.screenOf({ data: 'grid', table: 'Bus', id: 0 }),
  ]);
  gpu.destroy();
  gpu.destroy();
  stop();
  stop();
  destroyed(() => second.stats);
  destroyed(() => gpu.view(scene));
  for (const answer of await pending) {
    check(answer.status === 'rejected', 'destroying the view must cancel pending queries');
    const error: unknown = answer.reason;
    check(
      error instanceof Error && 'code' in error && error.code === 'cancelled',
      'query must reject with cancellation',
    );
  }
  check(data.query({ of: 'Bus' }).ids.length === 1, 'GPU cleanup must preserve independent data');
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
  const places = await Data.read(bytes, { name: 'places' });
  check(places.query({ of: 'points' }).ids.length === 1, 'worker must decode GeoJSON');
  if (custom) check(createdWorkers > 0, 'custom worker factory must be used');
  places.destroy();
  secondGpu.destroy();
  data.destroy();
  const exampleCanvas = document.createElement('canvas');
  exampleCanvas.width = exampleCanvas.height = 128;
  document.body.append(exampleCanvas);
  const example = await quickstart(exampleCanvas);
  await until(() => example.view.stats.drawn === 2);
  example.gpu.destroy();
  example.grid.destroy();
  exampleCanvas.remove();
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
    videoTested,
    initializationMs: initialized - started,
    gpuMs: deviceReady - initialized,
    firstFrameMs: firstFrame - started,
  };
}

Object.assign(window, { packageConsumer: { run } });
