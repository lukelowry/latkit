import { createData, selectBatches } from '@latkit/model';
import { protocol } from '@latkit/connect';
/* global document, GPUBufferUsage, GPUMapMode, PointerEvent, OffscreenCanvas, createImageBitmap */
import { createMonitor } from '@latkit/monitor';
import { kit } from '@latkit/gpu';
import { SignalSource } from './generated/fixture.js';
function assert(value, message) {
  if (!value) throw new Error(message);
}
/** Raw target pixels, for progressive frames a complete image never shows. */
async function pixels(gpu, target) {
  const stride = Math.ceil((target.width * 4) / 256) * 256,
    read = gpu.buffer({
      size: stride * target.height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  const encoder = gpu.device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target.texture() },
    { buffer: read.buffer, bytesPerRow: stride },
    [target.width, target.height],
  );
  gpu.device.queue.submit([encoder.finish()]);
  await read.buffer.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(read.buffer.getMappedRange()).slice();
  read.buffer.unmap();
  read.destroy();
  return { data, stride };
}
/** A complete image of a view, decoded to RGBA. */
async function snapshot(view, width = 512, height = 256) {
  const bitmap = await createImageBitmap(await view.image({ width, height, pixelRatio: 1 }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const context = new OffscreenCanvas(width, height).getContext('2d', {
    willReadFrequently: true,
  });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { data: context.getImageData(0, 0, width, height).data, stride: width * 4 };
}
/** The next value a view reports for an event, or undefined after a timeout. */
function next(view, event, ms = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(undefined);
    }, ms);
    const off = view.on(event, (value) => {
      clearTimeout(timer);
      off();
      resolve(value);
    });
  });
}
function bright(image, x, y, radius = 2) {
  let max = 0;
  for (let j = Math.max(0, Math.floor(y - radius)); j <= Math.min(255, Math.ceil(y + radius)); j++)
    for (
      let i = Math.max(0, Math.floor(x - radius));
      i <= Math.min(511, Math.ceil(x + radius));
      i++
    )
      max = Math.max(max, image.data[j * image.stride + i * 4]);
  return max > 80;
}
/** Block queries and field requests made through the Gpu's reader, in order. */
function record(gpu) {
  const queries = [],
    open = gpu.reader.open.bind(gpu.reader);
  gpu.reader.open = (options) => {
    const scope = open(options);
    return {
      get signal() {
        return scope.signal;
      },
      at: scope.at,
      get busy() {
        return scope.busy;
      },
      read(data, query) {
        queries.push(query);
        return scope.read(data, query);
      },
      fields(request) {
        queries.push({ kind: 'fields', rows: request.rows, window: request.window });
        return scope.fields(request);
      },
      extent: (request) => scope.extent(request),
      recording: (record) => scope.recording(record),
      hold: (entries) => scope.hold(entries),
      close: () => scope.close(),
    };
  };
  return queries;
}
export async function verify(gpu) {
  const queries = record(gpu);
  const checks = [];
  globalThis.pixelChecks = checks;
  const target = kit.createTextureTarget(gpu, { width: 512, height: 256 });
  const draw = (view, complete = true) =>
    gpu.render({
      views: [{ renderer: kit.rendererOf(view), target }],
      timeMs: 10,
      ...(complete ? { completion: 'complete' } : {}),
    });
  const render = async (source, extra = {}, trace = {}) => {
    const origin = source.options.valueOrigin ?? 0,
      lo = source.coordinate(0),
      hi = source.coordinate(source.frames - 1);
    const view = createMonitor(gpu, {
      source: source.data,
      traces: {
        a: {
          from: 'signal',
          y: 'value',
          widthPx: 2.5,
          color: [1, 0.25, 0.05, 1],
          ...trace,
        },
      },
      camera: { x: [lo, hi], y: [origin - 2, origin + 2] },
      xAxis: false,
      yAxis: false,
      paddingPx: 12,
      background: [0, 0, 0, 1],
      ...extra,
    });
    globalThis.checkView = view;
    return {
      view,
      image: await snapshot(view),
      x: (f) => 12 + ((source.coordinate(f) - lo) / (hi - lo)) * 488,
      y: (v) => 12 + ((origin + 2 - v) / 4) * 232,
    };
  };
  for (const mode of [
    'raw',
    'gaps',
    'relative',
    'envelope',
    'fallback',
    'relative envelope',
    'msaa',
  ]) {
    document.querySelector('#status').textContent = 'Pixel check: ' + mode;
    const source = new SignalSource(
      1,
      mode === 'envelope' || mode === 'fallback' || mode === 'relative envelope' ? 8192 : 128,
      {
        native: mode === 'envelope' || mode === 'relative envelope',
        gaps: mode === 'gaps',
        coordinateOrigin: mode.startsWith('relative') ? 2 ** 40 : 0,
        valueOrigin: mode.startsWith('relative') ? 2 ** 40 : 0,
        reverse: mode === 'raw',
        blockFrames: mode === 'raw' ? 7 : 1024,
      },
    );
    const out = await render(source, { msaa: mode === 'msaa' ? 4 : 1 });
    let found = 0,
      tested = 0;
    for (let f = 1; f < source.frames - 1; f += Math.max(1, Math.floor(source.frames / 100))) {
      if (!source.valid(0, f)) continue;
      tested++;
      if (bright(out.image, out.x(f), out.y(source.value(0, f)), 3)) found++;
    }
    assert(found / tested > 0.93, mode + ': missing native observations ' + found + '/' + tested);
    if (mode === 'gaps') {
      for (const f of [48, 49, 50, 51, 52])
        assert(
          !bright(out.image, out.x(f), out.y(source.value(0, f)), 1),
          'Line crosses an invalid observation',
        );
    }
    checks.push({ mode, found, tested });
    out.view.destroy();
  }
  for (const interpolation of ['step-before', 'step-after']) {
    const source = new SignalSource(1, 2);
    source.value = (_row, frame) => (frame === 0 ? -0.75 : 0.75);
    const out = await render(source, {}, { interpolation });
    const value = interpolation === 'step-before' ? 0.75 : -0.75;
    assert(bright(out.image, 256, out.y(value), 2), interpolation + ' does not preserve its step');
    assert(
      !bright(out.image, 256, out.y(-value), 2),
      interpolation + ' uses the wrong step orientation',
    );
    out.view.destroy();
    checks.push({ mode: interpolation, passed: true });
  }
  const focusSource = new SignalSource(2, 128);
  focusSource.value = (row) => (row ? 1 : -1);
  const focused = await render(focusSource, { selectedColor: [0, 1, 0, 1] });
  const hits = await focused.view.pick([focused.x(64), focused.y(1)], { radiusPx: 3, limit: 1 });
  assert(
    hits[0]?.row === 1 && hits[0].frame === focusSource.firstFrame + 64,
    'Picking lost the exact native observation',
  );
  focused.view.select([hits[0]]);
  const focusedPixels = await snapshot(focused.view);
  const ix = Math.round(focused.x(64)),
    iy = Math.round(focused.y(1)),
    pixel = iy * focusedPixels.stride + ix * 4;
  assert(
    focusedPixels.data[pixel + 1] > 100 && focusedPixels.data[pixel] < 30,
    'Focus did not composite the selected row',
  );
  focused.view.destroy();
  checks.push({ mode: 'native focus and picking', passed: true });
  // Check every submitted image, including intermediate work and cancelled replacements.
  const stableSource = new SignalSource(2, 256, { blockFrames: 16 });
  stableSource.value = (row) => (row ? 1 : -1);
  const stable = await render(stableSource, { selectedColor: [0, 1, 0, 1] });
  const stableRenderer = kit.rendererOf(stable.view);
  stable.view.select([
    { source: stableSource.data, index: stableSource.index, row: 1, field: 'value' },
  ]);
  await draw(stable.view);
  let checkedFrames = 0;
  async function checkStable() {
    const image = await pixels(gpu, target),
      x = Math.floor(target.width / 2);
    const color = (fraction, channel) => {
      const y = 12 + (target.height - 24) * fraction;
      let max = 0;
      for (let row = Math.floor(y) - 2; row <= Math.ceil(y) + 2; row++)
        max = Math.max(max, image.data[row * image.stride + x * 4 + channel]);
      return max;
    };
    assert(color(0.25, 1) > 100, 'Selected history disappeared during replacement');
    assert(color(0.75, 0) < 100, 'Unselected history flashed to full brightness');
    checkedFrames++;
  }
  const resizeReads = gpu.stats().queries;
  for (let i = 0; i < 12; i++) {
    target.resize({ width: 512 + i * 4, height: 256 + i * 2 });
    await draw(stable.view, false);
    await checkStable();
  }
  assert(gpu.stats().queries === resizeReads, 'Resize burst rebuilt source history');
  await draw(stable.view);
  await checkStable();
  const [lo, hi] = stable.view.camera.x,
    center = { coordinate: (lo + hi) / 2, value: 0 },
    presented = stable.view.locate(center);
  stable.view.set({ camera: { x: [0.2, 1.4] } });
  await draw(stable.view, false);
  await checkStable();
  // The axes and the stretched image show the new window at once, and so does locate.
  const moved = stable.view.locate(center);
  assert(moved && moved[0] !== presented[0], 'Locate does not follow the drawn camera');
  stable.view.set({ camera: { x: [0.4, 1.6] } });
  for (let i = 0; i < 300; i++) {
    await draw(stable.view, false);
    await checkStable();
    const pending = stableRenderer.pending;
    if (!pending) break;
    await pending;
  }
  assert(!stableRenderer.pending, 'Replacement did not complete');
  const committed = stable.view.locate({ coordinate: 1, value: 0 });
  assert(
    committed && Math.abs(committed[0] - target.width / 2) < 1e-6,
    'Final window was not committed',
  );
  stable.view.set({ msaa: 4 });
  await draw(stable.view, false);
  await checkStable();
  await draw(stable.view);
  await checkStable();
  stable.view.destroy();
  target.resize({ width: 512, height: 256 });
  checks.push({
    mode: 'resize, focus, cancellation and window continuity',
    checkedFrames,
    passed: true,
  });
  // Sampled visibility must refine raw samples instead of misapplying envelope representatives.
  document.querySelector('#status').textContent = 'Pixel check: visibility';
  const visibilityStart = queries.length;
  const visibility = new SignalSource(1, 4096, { native: true });
  const shown = await render(visibility, {}, { visible: 'visible' });
  assert(
    !queries.slice(visibilityStart).some((q) => q.kind === 'envelope'),
    'Sampled visibility used lossy summaries',
  );
  shown.view.destroy();
  checks.push({ mode: 'sampled visibility', passed: true });
  // A rejected shader never replaces the working pipeline.
  document.querySelector('#status').textContent = 'Pixel check: shade';
  const source = new SignalSource(1, 128);
  const effect = await render(source, {}, { shade: 'value' });
  const rejected = next(effect.view, 'error');
  effect.view.set({ shade: { wgsl: 'not valid WGSL' } });
  assert(await rejected, 'Invalid shade accepted');
  effect.view.set({
    shade: {
      wgsl: 'fn shade(f:ShadeFragment)->vec4f { return vec4f(0.0,1.0,0.0,f.color.a); }',
    },
  });
  // The working pipeline draws until the new one compiles and asks for a frame.
  const compiled = new Promise((resolve) => {
    const off = kit.rendererOf(effect.view).on('invalidate', () => {
      off();
      resolve();
    });
  });
  await Promise.race([compiled, next(effect.view, 'error')]);
  const green = await snapshot(effect.view);
  let colored = 0;
  for (let i = 0; i < green.data.length; i += 4)
    if (green.data[i + 1] > 100 && green.data[i] < 20) colored++;
  assert(colored > 100, 'Shared Shade did not affect history');
  effect.view.destroy();
  checks.push({ mode: 'transactional shade', passed: true });
  const local = new SignalSource(3, 128);
  const bounds = {
    messageBytes: 1024 * 1024,
    metadataBytes: 64 * 1024,
    publicationBatches: 64,
  };
  const received = [];
  for await (const batch of selectBatches(local.data, [{ from: 'signal', select: ['value'] }])) {
    const frame = protocol.decode(
      protocol.preparePublication(batch, 1, local.schema, bounds).encode(1),
      bounds,
    );
    received.push(...protocol.decodePublication({ bytes: frame.payload }, local.schema, bounds));
  }
  const delivered = createData(local.schema, received);
  const connected = createMonitor(gpu, {
    source: delivered,
    traces: { a: { from: 'signal', y: 'value' } },
    camera: { x: [0, 1.27], y: [-2, 2] },
    xAxis: false,
    yAxis: false,
  });
  try {
    await draw(connected);
    const coordinate = local.coordinate(60),
      value = local.value(1, 60);
    const hits = await connected.pick(
      [12 + (coordinate / 1.27) * 488, 12 + ((2 - value) / 4) * 232],
      { radiusPx: 0.25, limit: 3 },
    );
    assert(
      hits.some(
        (hit) =>
          hit.source === delivered &&
          hit.row === 1 &&
          hit.frame === local.firstFrame + 60 &&
          hit.value === value,
      ),
      'Connected source changed the native reading contract',
    );
    connected.destroy();
    assert(local.data.tables.signal.fields.value.length > 0, 'Application data changed');
    checks.push({ mode: 'decoded publication ownership', passed: true });
  } finally {
    connected.destroy();
  }
  target.destroy();
  await gpu.idle();
  gpu.trim();
  return checks;
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}
export async function benchmark(gpu) {
  const queries = record(gpu);
  const result = [];
  globalThis.benchmarkProgress = result;
  const target = kit.createTextureTarget(gpu, { width: 960, height: 480 });
  for (const [name, rows, frames] of [
    ['many rows', 100000, 32],
    ['long history', 1, 1000000],
    ['signals', 64, 4096],
  ]) {
    const source = new SignalSource(rows, frames, { native: true });
    const view = createMonitor(gpu, {
      source: source.data,
      traces: {
        signal: { from: 'signal', y: 'value', widthPx: 1, color: [0.2, 0.7, 0.9, 0.15] },
      },
      camera: { x: [0, source.coordinate(frames + 32)], y: [-1.4, 1.4] },
      xAxis: 'Coordinate',
      yAxis: 'Value',
      limits: { historyBytes: 96 * 1024 ** 2 },
    });
    const renderer = kit.rendererOf(view);
    globalThis.benchmarkView = view;
    const progress = { name, phase: 'initial', started: performance.now() };
    result.push(progress);
    document.querySelector('#status').textContent = 'Benchmark: ' + name;
    let prepared = [],
      began = performance.now();
    const finish = gpu.render({
      views: [{ renderer, target }],
      timeMs: 0,
      completion: 'complete',
    });
    await finish;
    await gpu.idle();
    const initialMs = performance.now() - began;
    progress.phase = 'steady';
    const reads = gpu.stats().queries,
      steady = [],
      moving = [];
    for (let i = 0; i < 45; i++) {
      began = performance.now();
      await gpu.render({
        views: [{ renderer, target, at: source.coordinate(i) }],
        timeMs: i * 16,
      });
      await gpu.idle();
      if (i >= 5) steady.push(performance.now() - began);
    }
    assert(gpu.stats().queries === reads, 'Playhead caused history queries');
    progress.phase = 'resizing';
    for (let i = 0; i < 25; i++) {
      target.resize({ width: 960 + (i % 2) * 4, height: 480 + (i % 2) * 2 });
      began = performance.now();
      await gpu.render({ views: [{ renderer, target }], timeMs: i * 16 });
      await gpu.idle();
      moving.push(performance.now() - began);
      prepared.push(view.stats().prepareMs);
    }
    assert(gpu.stats().queries === reads, 'Resizing caused history queries before settling');
    await gpu.render({ views: [{ renderer, target }], timeMs: 1000, completion: 'complete' });
    progress.phase = 'focus';
    const q = queries.length;
    view.select([{ source: source.data, index: source.index, row: 0, field: 'value' }]);
    began = performance.now();
    await gpu.render({ views: [{ renderer, target }], timeMs: 1000, completion: 'complete' });
    await gpu.idle();
    const focusMs = performance.now() - began;
    assert(
      queries
        .slice(q)
        .filter((q) => q.kind === 'samples' || q.kind === 'fields')
        .every((q) => q.rows?.kind === 'range' && q.rows.count === 1),
      'Focus expanded unrelated rows',
    );
    Object.assign(progress, {
      phase: 'complete',
      name,
      rows,
      observationsPerRow: frames,
      initialMs,
      steady: summary(steady),
      resizing: summary(moving),
      prepare: summary(prepared),
      focusMs,
      historyBytes: view.stats().historyBytes,
      gpu: gpu.stats(),
      noQueriesDuringInteraction: true,
    });
    view.destroy();
    await gpu.idle();
    gpu.trim();
  }
  target.destroy();
  return result;
}

// Actual requestAnimationFrame scheduling, with canvas pixels checked after each submission.
export async function canvasLatency(gpu) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:640px;height:240px;border:0';
  document.querySelector('#results').before(canvas);
  const copy = document.createElement('canvas'),
    ctx = copy.getContext('2d', { willReadFrequently: true });
  const source = new SignalSource(64, 4096, { native: true });
  const events = [];
  let firstVisibleMs,
    completeMs,
    resolve,
    reject,
    phase = 'initial',
    timer,
    received = 0,
    focusedAt,
    focusMs;
  const finished = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const started = performance.now();
  const monitor = createMonitor(gpu, {
    canvas,
    source: source.data,
    traces: { a: { from: 'signal', y: 'value', color: [0, 1, 0, 1], widthPx: 3 } },
    camera: { x: [0, 41], y: [-2, 2] },
    xAxis: false,
    yAxis: false,
  });
  let live,
    selected = false;
  monitor.on('error', reject);
  monitor.on('select', (readings) => {
    selected = readings.length > 0;
  });
  const deadlines = setTimeout(
    () => reject(new Error('Canvas streaming benchmark timed out')),
    20000,
  );
  function capture() {
    copy.width = canvas.width;
    copy.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    return ctx.getImageData(0, 0, copy.width, copy.height);
  }
  function green(image, x, y) {
    const ratio = canvas.width / 640;
    let found = false;
    for (
      let j = Math.max(0, Math.floor(y * ratio) - 3);
      j <= Math.min(image.height - 1, Math.ceil(y * ratio) + 3);
      j++
    )
      for (
        let i = Math.max(0, Math.floor(x * ratio) - 3);
        i <= Math.min(image.width - 1, Math.ceil(x * ratio) + 3);
        i++
      )
        if (image.data[(j * image.width + i) * 4 + 1] > 100) found = true;
    return found;
  }
  const rendered = () => {
    const now = performance.now();
    if (phase === 'initial') {
      if (monitor.stats().visible && firstVisibleMs === undefined) {
        const image = capture();
        assert(
          image.data.some((v, i) => i % 4 === 1 && v > 100),
          'Published initial canvas was blank',
        );
        firstVisibleMs = now - started;
      }
      if (!monitor.stats().refining) {
        completeMs = now - started;
        phase = 'focus';
        focusedAt = now;
        const rect = canvas.getBoundingClientRect(),
          x = 12 + (source.coordinate(250) / 41) * 616,
          y = 12 + ((2 - source.value(0, 250)) / 4) * 216;
        for (const type of ['pointerdown', 'pointerup'])
          canvas.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 1,
              button: 0,
              clientX: rect.x + x,
              clientY: rect.y + y,
              bubbles: true,
            }),
          );
      }
    } else if (phase === 'focus' && selected && !monitor.stats().refining) {
      focusMs = now - focusedAt;
      phase = 'empty';
      live = new SignalSource(1, 0);
      live.value = () => 0;
      monitor.set({ source: live.data, camera: { x: [0, 1] } });
    } else if (phase === 'empty' && !monitor.stats().refining) {
      phase = 'stream';
      timer = setInterval(() => {
        events.push({ coordinate: live.coordinate(received), receivedAt: performance.now() });
        received++;
        live.append(1);
        monitor.set({ source: live.data });
        if (received === 40) {
          clearInterval(timer);
          timer = undefined;
        }
      }, 8);
    } else if (phase === 'stream') {
      const image = capture();
      for (const event of events)
        if (event.latencyMs === undefined && green(image, 12 + event.coordinate * 616, 120))
          event.latencyMs = now - event.receivedAt;
      if (
        received === 40 &&
        events.every((e) => e.latencyMs !== undefined) &&
        !monitor.stats().refining
      ) {
        phase = 'done';
        resolve({
          firstVisibleMs,
          completeMs,
          clickToFocusMs: focusMs,
          stream: summary(events.map((e) => e.latencyMs)),
          received,
          visible: events.length,
        });
      }
    }
  };
  monitor.on('frame', () => {
    try {
      rendered();
    } catch (error) {
      reject(error);
    }
  });
  try {
    return await finished;
  } finally {
    clearTimeout(deadlines);
    if (timer) clearInterval(timer);
    monitor.destroy();
    canvas.remove();
  }
}
