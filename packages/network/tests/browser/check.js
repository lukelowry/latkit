/* global document, OffscreenCanvas, createImageBitmap */
import { createGpu, colormaps, kit } from '@latkit/gpu';
import { createNetwork } from '@latkit/network';
import {
  PathSource,
  featureSource,
  references,
  vectors,
} from '/output/network-fixture/paths-fixture.js';
import { GraphSource } from '/output/network-fixture/fixture.js';

const el = (id) => document.getElementById(id);
const errors = [];
let gpu,
  network,
  source,
  at = 0,
  geographic = false,
  labelled = true,
  borders;
function fail(error) {
  errors.push(error.message ?? String(error));
  el('error').textContent = errors.join('\n');
}
function data(source, labels = true) {
  return {
    source: source.data,
    vertices: {
      node: {
        x: 'location',
        y: { field: 'location', component: 1 },
        color: { field: 'signal', domain: [0, 1], colormap: colormaps.viridis },
        radiusPx: { field: 'weight', domain: [0, 1], range: [2.8, 6] },
        labels: labels ? { field: 'name', fontSizePx: 11, maxCount: 45 } : null,
      },
    },
    paths:
      source.geographic && borders && el('borders').checked
        ? {
            border: {
              source: borders.data,
              points: 'points',
              widthPx: 0.8,
              color: [0.45, 0.62, 0.68, 0.72],
            },
          }
        : undefined,
    edges: {
      line: {
        route: source.geographic && el('geodesic').checked ? 'geodesic' : 'straight',
        ends: ['from', 'to'],
        color: { field: 'signal', domain: [0, 1], colormap: colormaps.viridis },
      },
    },
  };
}
function channelBindings() {
  return {
    x: el('channel-x').checked ? 'x' : 'baseX',
    y: el('channel-y').checked ? 'y' : 'baseY',
    z: el('channel-z').checked ? { field: 'z', domain: [0, 1], range: [0, 1] } : null,
    color: el('channel-color').checked
      ? { field: 'signal', domain: [0, 1], colormap: colormaps.viridis }
      : null,
  };
}
function recordingControls(enabled) {
  for (const id of ['channel-color', 'channel-x', 'channel-y', 'channel-z', 'time'])
    el(id).disabled = !enabled;
}
function updateChannels() {
  network.set({
    vertices: { node: channelBindings() },
    edges: {
      line: {
        color: el('channel-color').checked
          ? { field: 'signal', domain: [0, 1], colormap: colormaps.viridis }
          : null,
      },
    },
  });
}
function update() {
  const stats = network.stats();
  el('vertices').textContent = stats.vertices.toLocaleString();
  el('edges').textContent = stats.edges.toLocaleString();
  el('prepare').textContent = stats.prepareMs.toFixed(2) + ' ms';
  el('memory').textContent = (gpu.stats().gpuBytes / 1048576).toFixed(1) + ' MB';
  el('queries').textContent = source.queries;
  const hover = {
    off: 'Off',
    idle: 'Ready',
    active: 'Active',
    moving: 'Paused during motion',
    budget: 'Paused: budget reached',
  };
  el('hover-state').textContent =
    hover[stats.hover] + (stats.hoverMs ? ' (' + stats.hoverMs.toFixed(2) + ' ms)' : '');
}
/** Report the presented network after each frame. */
function observe(describe) {
  network.on('error', fail);
  network.on('frame', update);
  network.on('select', (items) => {
    el('status').textContent = describe(items[0]);
  });
}
function show(count = Number(el('size').value), geo = geographic) {
  network?.destroy();
  source = new GraphSource(count, 4096, geo);
  geographic = geo;
  recordingControls(true);
  network = createNetwork(gpu, {
    ...data(source, labelled),
    canvas: el('graph'),
    at,
    camera: { projection: geo ? 'globe' : 'flat', pitch: geo ? 15 : 0 },
    vertexRadiusPx: count > 10000 ? 1.4 : count > 1000 ? 2 : 4,
    edgeWidthPx: count > 10000 ? 0.5 : 1.1,
    grid: geo,
    daylight: geo,
    sunTime: Date.UTC(2026, 8, 30, 17),
    msaa: 4,
    poles: el('poles').checked,
    hover: el('hover-mode').value,
    hoverBudgetMs: Number(el('hover-budget').value),
  });
  updateChannels();
  observe((item) => (item ? 'Selected ' + item.index.type + ' row ' + item.row : 'Interactive'));
  el('status').textContent = 'Interactive';
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
/** Pan by pixels on a flat, unrotated camera, as a drag does. */
function pan(view, dx, dy) {
  const { center, scale } = view.camera;
  view.set({ camera: { center: [center[0] - dx / scale, center[1] + dy / scale] } });
}
/** Wait until a view's background hit-test indexes stop growing. */
async function indexed(view) {
  for (let last = -1; view.stats().pickingBytes !== last;) {
    last = view.stats().pickingBytes;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
/** RGBA bytes of an offscreen image of the view. */
async function pixels(view, options) {
  const bitmap = await createImageBitmap(await view.image(options), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const { width, height } = bitmap,
    context = new OffscreenCanvas(width, height).getContext('2d');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, width, height).data;
}
async function benchmark(count = 100000) {
  network?.set({ paused: true });
  const baseline = gpu.stats();
  const fixture = new GraphSource(count, 4096),
    view = createNetwork(gpu, {
      ...data(fixture, false),
      msaa: 1,
      vertexRadiusPx: 1,
      edgeWidthPx: 0.6,
    });
  const renderer = kit.rendererOf(view),
    target = kit.createTextureTarget(gpu, { width: 1280, height: 720 });
  const render = (coordinate) =>
    gpu.render({ timeMs: 0, views: [{ renderer, target, at: coordinate }] });
  try {
    const start = performance.now();
    await render(0);
    await gpu.idle();
    const coldMs = performance.now() - start;
    const beforeQueries = fixture.queries,
      beforeUploads = gpu.stats().uploadedBytes;
    const cpu = [],
      complete = [];
    for (let i = 0; i < 12; i++) {
      pan(view, i % 2 ? 2 : -2, 0);
      const t = performance.now();
      await render(0);
      cpu.push(performance.now() - t);
      await gpu.idle();
      complete.push(performance.now() - t);
    }
    const cameraUploads = gpu.stats().uploadedBytes - beforeUploads,
      cameraQueries = fixture.queries - beforeQueries;
    const sampled = [];
    for (let i = 1; i <= 8; i++) {
      const t = performance.now();
      await render(i);
      await gpu.idle();
      sampled.push(performance.now() - t);
    }
    assert(cameraQueries === 0, 'Camera motion queried the source');
    assert(cameraUploads < 12 * 250000, 'Camera motion reuploaded model-sized arrays');
    return {
      vertices: count,
      edges: fixture.from.length,
      coldMs,
      steadySubmitMedianMs: median(cpu),
      steadyCompleteMedianMs: median(complete),
      recordingCompleteMedianMs: median(sampled),
      cameraQueries,
      cameraUploadedBytes: cameraUploads,
      drawCalls: view.stats().drawCalls,
      gpu: {
        cpuBytes: gpu.stats().cpuBytes,
        gpuBytes: gpu.stats().gpuBytes,
        uploadedBytes: gpu.stats().uploadedBytes - baseline.uploadedBytes,
        stagedBytes: gpu.stats().stagedBytes - baseline.stagedBytes,
      },
    };
  } finally {
    view.destroy();
    target.destroy();
    await gpu.idle();
    gpu.trim();
    network?.set({ paused: false });
  }
}
async function benchmarkHover(count = 100000) {
  network?.set({ paused: true });
  const fixture = new GraphSource(count, 4096, true);
  const view = createNetwork(gpu, {
    ...data(fixture, false),
    msaa: 1,
    vertexRadiusPx: 1.4,
    edgeWidthPx: 0.5,
    poles: false,
  });
  const renderer = kit.rendererOf(view),
    target = kit.createTextureTarget(gpu, { width: 1280, height: 720 });
  const render = (at = 0) => gpu.render({ timeMs: 0, views: [{ renderer, target, at }] });
  const results = [];
  const percentile = (values, fraction) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  try {
    for (const projection of ['flat', 'tilt', 'globe']) {
      // The pointer hook input drives; frames search for hover.
      view.pointer(null);
      view.set({ camera: { projection, pitch: projection === 'flat' ? 0 : 50, fit: true } });
      await render();
      view.set({ camera: { fit: false } });
      for (const moving of [false, true]) {
        view.set({
          vertices: {
            node: moving
              ? { x: 'x', y: 'y', z: { field: 'z', domain: [0, 1] } }
              : { x: 'location', y: { field: 'location', component: 1 }, z: null },
          },
        });
        // Warm the same coordinates for both policies before measuring.
        view.set({ hover: 'off' });
        for (let i = 0; i < 8; i++) await render(moving ? i : 0);
        await gpu.idle();
        await new Promise((resolve) => setTimeout(resolve, 160));
        // Positions that hold still get hit-test indexes in the background; hover uses them.
        if (!moving) await indexed(view);
        for (const hover of ['auto', 'off']) {
          view.set({ hover });
          const pointer = [],
            submit = [],
            complete = [],
            searches = [];
          const beforeQueries = fixture.queries,
            beforeEnds = fixture.endsQueries;
          const states = new Set();
          for (let i = 0; i < 8; i++) {
            const point = [640 + Math.cos(i * 0.43) * 70, 360 + Math.sin(i * 0.43) * 50];
            let start = performance.now();
            view.pointer(point);
            pointer.push(performance.now() - start);
            start = performance.now();
            await render(moving ? i : 0);
            submit.push(performance.now() - start);
            await gpu.idle();
            complete.push(performance.now() - start);
            searches.push(view.stats().hoverMs);
            states.add(view.stats().hover);
          }
          // Indexes build in the background, never in a hover search, within the default 64 MiB.
          assert(
            view.stats().pickingBytes <= 64 * 1024 ** 2,
            'Hit-test indexes outgrew pickingBytes',
          );
          assert(fixture.endsQueries === beforeEnds, 'Hover reread the edge ends');
          results.push({
            projection,
            coordinates: moving ? 'recording XYZ' : 'static',
            hover,
            vertices: count,
            edges: fixture.from.length,
            samples: pointer.length,
            pointerMedianMs: median(pointer),
            pointerP95Ms: percentile(pointer, 0.95),
            submitMedianMs: median(submit),
            completeMedianMs: median(complete),
            completeP95Ms: percentile(complete, 0.95),
            latestSearchMs: view.stats().hoverMs,
            maxSearchMs: Math.max(...searches),
            states: [...states],
            pickingBytes: view.stats().pickingBytes,
            sourceQueries: fixture.queries - beforeQueries,
            endsQueries: fixture.endsQueries - beforeEnds,
          });
        }
      }
    }
    return results;
  } finally {
    view.destroy();
    target.destroy();
    await gpu.idle();
    gpu.trim();
    network?.set({ paused: false });
  }
}
async function checks() {
  const adapter = await navigator.gpu?.requestAdapter();
  assert(adapter, 'WebGPU unavailable');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => fail(e.error));
  gpu = await createGpu({
    device,
    budget: { cpuBytes: 256 * 1024 ** 2, gpuBytes: 512 * 1024 ** 2, entries: 30000 },
  });
  show();
  const checks = [];
  const fixture = new GraphSource(25, 3),
    view = createNetwork(gpu, {
      ...data(fixture, false),
      msaa: 1,
      vertexRadiusPx: 8,
      daylight: false,
    });
  const size = { width: 256, height: 256 };
  try {
    device.pushErrorScope('validation');
    const bytes = await pixels(view, { ...size, at: 0 });
    let bright = 0;
    for (let i = 0; i < bytes.length; i += 4) if (bytes[i + 1] > 80 || bytes[i + 2] > 100) bright++;
    assert(bright > 400, 'Graph did not produce visible pixels');
    const item = { kind: 'vertex', source: fixture.data, index: fixture.index('node'), row: 12 },
      located = view.locate(item);
    assert(located, 'Native vertex could not be located');
    const hits = await view.pick(located);
    assert(hits[0]?.kind === 'vertex' && hits[0]?.row === 12, 'Picking lost physical row identity');
    view.set({ camera: { projection: 'tilt', pitch: 45 } });
    await view.image({ ...size, at: 1 });
    const tilt = view.locate(item);
    assert((await view.pick(tilt))[0]?.row === 12, 'Tilt picking differs from geometry');
    const ends = fixture.endsQueries;
    view.set({
      vertices: { node: { x: 'x', y: 'y', z: { field: 'z', domain: [0, 1] } } },
    });
    await view.image({ ...size, at: 2 });
    const moving = view.locate(item);
    assert(
      Math.hypot(moving[0] - tilt[0], moving[1] - tilt[1]) > 1,
      'Recording positions did not move the vertex',
    );
    assert(
      (await view.pick(moving)).some((hit) => hit.kind === 'vertex' && hit.row === item.row),
      'Sampled position picking lost row identity',
    );
    assert(fixture.endsQueries === ends, 'Changing recording channels reread the edge ends');
    const error = await device.popErrorScope();
    assert(!error, error?.message);
    checks.push(
      'Real GPU pixels',
      'Native identity picking',
      'Tilt projection',
      'Small native blocks / cross-page fields',
      'Sampled X / Y / Z position and picking',
      'Sampled channels keep the edge ends',
    );
  } finally {
    view.destroy();
  }
  const features = featureSource();
  const featureView = createNetwork(gpu, {
    source: features.data,
    vertices: {
      node: {
        x: 'position',
        y: { field: 'position', component: 1 },
        labels: { field: 'name', maxCount: 4 },
      },
    },
    edges: {
      route: { ends: ['from', 'to'], route: 'geodesic', labels: { field: 'name' } },
      star: {},
      bend: { ends: ['from', 'to'], bends: 'points' },
    },
    paths: { seam: { points: 'points', pickable: true } },
    camera: { center: [-30, 5], scale: 3 },
    edgeWidthPx: 3,
  });
  try {
    device.pushErrorScope('validation');
    for (const projection of ['flat', 'tilt', 'globe']) {
      featureView.set({ camera: { projection, pitch: projection === 'tilt' ? 40 : 0 } });
      await featureView.image({ width: 512, height: 512 });
      const item = { kind: 'edge', source: features.data, index: features.index('route'), row: 0 },
        located = featureView.locate(item);
      assert(
        located && (await featureView.pick(located)).some((hit) => hit.index.type === 'route'),
        'Geodesic picking failed in ' + projection,
      );
    }
    const star = { kind: 'edge', source: features.data, index: features.index('star'), row: 0 };
    assert(
      featureView.neighborhood(star).filter((item) => item.kind === 'vertex').length === 4,
      'Net adjacency lost vertices',
    );
    featureView.select([star]);
    await featureView.image({ width: 512, height: 512 });
    const error = await device.popErrorScope();
    assert(!error, error?.message);
    checks.push(
      'Adaptive GPU geodesics and matching picking',
      'Native bends / complete net adjacency',
      'Shared vertex and edge text anchors',
    );
  } finally {
    featureView.destroy();
  }
  const seamSource = new PathSource({
    node: { position: vectors([170, 20, -170, 20]) },
    route: {
      dashed: { kind: 'boolean', offset: 0, length: 1, values: Uint8Array.of(1) },
      from: references('node', [0]),
      to: references('node', [1]),
    },
  });
  const seamView = createNetwork(gpu, {
    source: seamSource.data,
    vertices: { node: { x: 'position', y: { field: 'position', component: 1 } } },
    edges: { route: { ends: ['from', 'to'], route: 'geodesic' } },
    camera: { center: [0, 20], scale: 1.2 },
    markers: false,
    earthAxis: false,
    edgeColor: [1, 1, 1, 1],
    background: [0, 0, 0, 1],
    surfaceColor: [0, 0, 0, 1],
    edgeWidthPx: 2,
    dashPeriodPx: 8,
    msaa: 1,
  });
  try {
    device.pushErrorScope('validation');
    const counts = [];
    for (const dash of [null, 'dashed']) {
      seamView.set({ edges: { route: { dash } } });
      const bytes = await pixels(seamView, { width: 512, height: 512 });
      let left = 0,
        right = 0,
        middle = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if (bytes[i] < 150 || bytes[i + 1] < 150 || bytes[i + 2] < 150) continue;
        const x = (i / 4) % 512;
        if (x < 100) left++;
        else if (x > 412) right++;
        else middle++;
      }
      assert(
        left > 10 && right > 10 && middle === 0,
        'Geodesic must split at the dateline without crossing the map',
      );
      counts.push(left + right);
    }
    assert(
      counts[1] < counts[0] * 0.85 && counts[1] > counts[0] * 0.2,
      'Dashed seam segments did not preserve their screen-space pattern',
    );
    const error = await device.popErrorScope();
    assert(!error, error?.message);
    checks.push('Dashed geodesic seam pixels / hidden vertex markers');
  } finally {
    seamView.destroy();
  }
  const result = {
    adapter: adapter.info
      ? {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          device: adapter.info.device,
          description: adapter.info.description,
        }
      : null,
    checks,
    benchmarks: [await benchmark(10000), await benchmark(100000)],
    interaction: await benchmarkHover(100000),
    paths: await benchmarkPaths(100000),
    movingPaths: await benchmarkPaths(100000, true),
  };
  assert(!errors.length, errors.join('\n'));
  el('report').textContent = JSON.stringify(result, null, 2);
  el('status').textContent = 'Checks passed - interactive';
  return result;
}
el('size').addEventListener('change', () => show());
el('flat').onclick = () => {
  if (geographic && source instanceof GraphSource) show(Number(el('size').value), false);
  else network.set({ camera: { projection: 'flat', pitch: 0, fit: true } });
};
el('tilt').onclick = () => network.set({ camera: { projection: 'tilt', pitch: 50, fit: false } });
el('globe').onclick = () => {
  if (source instanceof GraphSource) show(Number(el('size').value), true);
  else network.set({ camera: { projection: 'globe', pitch: 0, fit: false } });
};
el('fit').onclick = () => network.fit(undefined, { animate: true });
el('orbit').onclick = () => network.set({ camera: { orbit: !network.camera.orbit } });
el('labels').onclick = () => {
  labelled = !labelled;
  network.set({
    vertices: { node: { labels: labelled ? { field: 'name', size: 11, maxCount: 45 } : null } },
  });
};
el('time').oninput = () => {
  at = Number(el('time').value);
  el('time-value').textContent = at + ' s';
  network.set({ at });
};
el('benchmark').onclick = () => {
  el('status').textContent = 'Benchmarking...';
  void benchmark(Number(el('size').value)).then((result) => {
    el('report').textContent = JSON.stringify(result, null, 2);
    el('status').textContent = 'Benchmark complete';
  }, fail);
};
for (const channel of ['color', 'x', 'y', 'z'])
  el('channel-' + channel).addEventListener('change', updateChannels);
el('poles').onchange = () => network.set({ poles: el('poles').checked });
el('hover-mode').onchange = () => network.set({ hover: el('hover-mode').value });
el('hover-budget').onchange = () => {
  if (el('hover-budget').reportValidity())
    network.set({ hoverBudgetMs: Number(el('hover-budget').value) });
};
el('hover-benchmark').onclick = () => {
  el('status').textContent = 'Measuring hover in all projections...';
  void benchmarkHover(Number(el('size').value)).then((result) => {
    el('report').textContent = JSON.stringify(result, null, 2);
    el('status').textContent = 'Hover benchmark complete';
  }, fail);
};

async function loadBorders() {
  if (borders) return borders;
  const [points, offsets] = await Promise.all(
    ['points', 'offsets'].map(async (name) => {
      const response = await fetch('../assets/borders.' + name + '.bin');
      if (!response.ok) throw new Error('Could not load native border fixture');
      return response.arrayBuffer();
    }),
  );
  const values = new Float32Array(points),
    lists = new Int32Array(offsets);
  borders = new PathSource({
    border: {
      points: {
        kind: 'list',
        offset: 0,
        length: lists.length - 1,
        offsets: lists,
        values: {
          kind: 'vector',
          offset: 0,
          length: values.length / 2,
          size: 2,
          values: { kind: 'numeric', offset: 0, length: values.length, values },
        },
      },
    },
  });
  return borders;
}
async function showFeatures(reset = true) {
  if (reset) {
    el('borders').checked = true;
    el('geodesic').checked = true;
  }
  recordingControls(false);
  await loadBorders();
  network?.destroy();
  source = featureSource();
  geographic = true;
  network = createNetwork(gpu, {
    canvas: el('graph'),
    at: 0,
    source: source.data,
    vertices: {
      node: { x: 'position', y: { field: 'position', component: 1 }, labels: { field: 'name' } },
    },
    edges: {
      bend: { ends: ['from', 'to'], bends: 'points', labels: { field: 'name' } },
      star: { labels: { field: 'name' } },
      route: {
        ends: ['from', 'to'],
        route: el('geodesic').checked ? 'geodesic' : 'straight',
        labels: { field: 'name' },
      },
    },
    paths: {
      ...(el('borders').checked
        ? {
            border: {
              source: borders.data,
              points: 'points',
              widthPx: 0.8,
              color: [0.3, 0.48, 0.58, 0.75],
            },
          }
        : {}),
      seam: { points: 'points', pickable: true, widthPx: 2, color: [1, 0.6, 0.25, 1] },
    },
    camera: { center: [-35, 5], scale: 4, projection: 'globe', pitch: 0 },
    poles: el('poles').checked,
    hover: el('hover-mode').value,
    hoverBudgetMs: Number(el('hover-budget').value),
    edgeColor: [0.95, 0.67, 0.25, 1],
    edgeWidthPx: 2,
    grid: true,
  });
  observe((item) =>
    item ? item.kind + ' / ' + item.index.type + ' / row ' + item.row : 'Geometry features',
  );
  el('status').textContent = 'Bends, four-way junction, geodesic, borders and shared labels';
}
async function benchmarkPaths(count = 100000, moving = false) {
  network?.set({ paused: true });
  const borders = await loadBorders(),
    fixture = new GraphSource(count, 4096, true),
    results = [];
  const target = kit.createTextureTarget(gpu, { width: 1200, height: 700, format: 'rgba8unorm' });
  try {
    for (const route of ['straight', 'geodesic'])
      for (const detailed of [false, true]) {
        const input = data(fixture, false);
        input.edges.line.route = route;
        if (moving) {
          input.vertices.node = {
            ...input.vertices.node,
            x: 'x',
            y: 'y',
            z: { field: 'z', domain: [0, 1] },
          };
        }
        input.paths = detailed
          ? { border: { source: borders.data, points: 'points', widthPx: 0.8 } }
          : undefined;
        const view = createNetwork(gpu, {
          ...input,
          camera: { center: [-65, 5], scale: 4, projection: 'globe', pitch: 15 },
          hover: 'auto',
          poles: false,
          vertexRadiusPx: 1.4,
          edgeWidthPx: 0.5,
          msaa: 4,
        });
        const renderer = kit.rendererOf(view);
        const draw = async (i) => {
          view.set({ camera: { bearing: i * 0.3 } });
          const start = performance.now();
          await gpu.render({
            timeMs: i * 16,
            views: [{ renderer, target, at: moving ? i % 16 : 0 }],
          });
          const submit = performance.now() - start;
          await gpu.idle();
          return [submit, performance.now() - start];
        };
        try {
          const cold = await draw(0);
          for (let i = 0; i < (moving ? 32 : 24); i++) await draw(i);
          const before = gpu.stats(),
            queries = fixture.queries + borders.queries,
            times = [];
          for (let i = 0; i < 16; i++) times.push(await draw(i));
          const sorted = times.map((t) => t[1]).sort((a, b) => a - b),
            submit = times.map((t) => t[0]).sort((a, b) => a - b);
          results.push({
            route,
            moving,
            detailedBorders: detailed,
            vertices: count,
            coldMs: cold[1],
            submitMedianMs: submit[8],
            completeMedianMs: sorted[8],
            completeP95Ms: sorted[15],
            cameraQueries: fixture.queries + borders.queries - queries,
            cameraUploadedBytes: gpu.stats().uploadedBytes - before.uploadedBytes,
            stats: view.stats(),
          });
        } finally {
          view.destroy();
          await gpu.idle();
          gpu.trim();
        }
      }
  } finally {
    target.destroy();
    network?.set({ paused: false });
  }
  return results;
}
el('geodesic').onchange = () => {
  const route = el('geodesic').checked ? 'geodesic' : 'straight';
  if (!geographic) show(Number(el('size').value), true);
  else if (source instanceof GraphSource) network.set({ edges: { line: { route } } });
  else network.set({ edges: { route: { route } } });
};
el('borders').onchange = () => {
  void loadBorders().then(
    () =>
      source instanceof GraphSource ? show(Number(el('size').value), true) : showFeatures(false),
    fail,
  );
};
el('features').onclick = () => {
  void showFeatures().catch(fail);
};
el('paths-benchmark').onclick = () => {
  el('status').textContent = 'Measuring geodesics and detailed borders...';
  void benchmarkPaths(Number(el('size').value)).then((result) => {
    el('report').textContent = JSON.stringify(result, null, 2);
    el('status').textContent = 'Path benchmark complete';
  }, fail);
};

globalThis.networkCheck = checks().catch((error) => {
  fail(error);
  throw error;
});
globalThis.networkFixture = {
  get network() {
    return network;
  },
  get gpu() {
    return gpu;
  },
  show,
  benchmark,
  benchmarkHover,
  benchmarkPaths,
  showFeatures,
  get source() {
    return source;
  },
};
