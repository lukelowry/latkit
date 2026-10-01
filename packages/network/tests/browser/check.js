/* global document, GPUBufferUsage, GPUMapMode */
import { createGpu, createCanvasView, createRenderTarget } from '@latkit/gpu';
import { createNetwork, attachNetworkInput } from '@latkit/network';
import { colormaps } from '@latkit/gpu';
import { PathSource, featureSource, vectors } from '../../dist/paths-fixture.js';
import { GraphSource } from '../../dist/fixture.js';

const el = (id) => document.getElementById(id);
const errors = [];
let gpu,
  network,
  view,
  detach,
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
    source,
    coordinates: source.geographic ? 'geographic' : 'cartesian',
    vertices: {
      node: {
        position: 'location',
        color: { field: 'signal', domain: [0, 1], colormap: colormaps.viridis },
        size: { field: 'weight', domain: [0, 1], range: [0.7, 1.5] },
        labels: labels ? { field: 'name', size: 11, maxCount: 45 } : null,
      },
    },
    paths:
      source.geographic && borders && el('borders').checked
        ? {
            border: {
              source: borders,
              points: 'points',
              widthPx: 0.8,
              baseColor: [0.45, 0.62, 0.68, 0.72],
            },
          }
        : undefined,
    edges: {
      line: {
        curve: source.geographic && el('geodesic').checked ? 'geodesic' : 'linear',
        connectivity: {
          kind: 'links',
          ports: ['a', 'b'],
          through: 'attachment',
          role: 'node',
          to: 'node',
        },
        color: { field: 'signal', domain: [0, 1], colormap: colormaps.viridis },
      },
    },
  };
}
function channelBindings() {
  return {
    position: {
      x: el('channel-x').checked ? 'x' : 'baseX',
      y: el('channel-y').checked ? 'y' : 'baseY',
    },
    height: el('channel-z').checked ? { field: 'z', domain: [0, 1], range: [0, 1] } : null,
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
  network.setVertex('node', channelBindings());
  network.setEdge('line', {
    color: el('channel-color').checked
      ? { field: 'signal', domain: [0, 1], colormap: colormaps.viridis }
      : null,
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
function show(count = Number(el('size').value), geo = geographic) {
  detach?.();
  view?.destroy();
  network?.destroy();
  source = new GraphSource(count, 4096, geo);
  geographic = geo;
  recordingControls(true);
  network = createNetwork({
    gpu,
    data: data(source, labelled),
    camera: { projection: geo ? 'globe' : 'flat', pitch: geo ? 15 : 0 },
    options: {
      vertexRadiusPx: count > 10000 ? 1.4 : count > 1000 ? 2 : 4,
      edgeWidthPx: count > 10000 ? 0.5 : 1.1,
      graticule: geo,
      daylight: geo,
      sunTime: Date.UTC(2026, 8, 30, 17),
      msaa: 4,
      poles: el('poles').checked,
      hover: el('hover-mode').value,
      hoverBudgetMs: Number(el('hover-budget').value),
    },
  });
  updateChannels();
  network.on('select', (item) => {
    el('status').textContent = item
      ? 'Selected ' + item.index.type + ' row ' + item.row
      : 'Interactive';
  });
  view = createCanvasView({
    gpu,
    canvas: el('graph'),
    renderer: network,
    onError: fail,
    onRendered: update,
  });
  detach = attachNetworkInput({ network, canvas: el('graph') });
  view.request({ at });
  el('status').textContent = 'Interactive';
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function benchmark(count = 100000) {
  view?.pause();
  const baseline = gpu.stats();
  const fixture = new GraphSource(count, 4096),
    renderer = createNetwork({
      gpu,
      data: data(fixture, false),
      options: { msaa: 1, vertexRadiusPx: 1, edgeWidthPx: 0.6 },
    });
  const target = createRenderTarget({ gpu, width: 1280, height: 720 });
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
      renderer.panBy(i % 2 ? 2 : -2, 0);
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
      drawCalls: renderer.stats().drawCalls,
      gpu: {
        cpuBytes: gpu.stats().cpuBytes,
        gpuBytes: gpu.stats().gpuBytes,
        uploadedBytes: gpu.stats().uploadedBytes - baseline.uploadedBytes,
        stagedBytes: gpu.stats().stagedBytes - baseline.stagedBytes,
      },
    };
  } finally {
    renderer.destroy();
    target.destroy();
    await gpu.idle();
    gpu.trim();
    view?.resume();
  }
}
async function benchmarkHover(count = 100000) {
  view?.pause();
  const fixture = new GraphSource(count, 4096, true);
  const renderer = createNetwork({
    gpu,
    data: data(fixture, false),
    options: { msaa: 1, vertexRadiusPx: 1.4, edgeWidthPx: 0.5, poles: false },
  });
  const target = createRenderTarget({ gpu, width: 1280, height: 720 });
  const render = (at = 0) => gpu.render({ timeMs: 0, views: [{ renderer, target, at }] });
  const results = [];
  const percentile = (values, fraction) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  try {
    for (const projection of ['flat', 'tilt', 'globe']) {
      renderer.setPointer(null);
      renderer.setCamera({ projection, pitch: projection === 'flat' ? 0 : 50, fit: true });
      await render();
      renderer.setCamera({ fit: false });
      for (const moving of [false, true]) {
        renderer.setVertex('node', {
          position: moving ? { x: 'x', y: 'y' } : 'location',
          height: moving ? { field: 'z', domain: [0, 1] } : null,
        });
        // Warm the same coordinates for both policies before measuring.
        renderer.setOptions({ hover: 'off' });
        for (let i = 0; i < 8; i++) await render(moving ? i : 0);
        await gpu.idle();
        await new Promise((resolve) => setTimeout(resolve, 160));
        for (const hover of ['auto', 'off']) {
          renderer.setOptions({ hover });
          const pointer = [],
            submit = [],
            complete = [],
            searches = [];
          const beforeQueries = fixture.queries,
            beforeLinks = fixture.linksQueries;
          const states = new Set();
          for (let i = 0; i < 8; i++) {
            const point = [640 + Math.cos(i * 0.43) * 70, 360 + Math.sin(i * 0.43) * 50];
            let start = performance.now();
            renderer.setPointer(point);
            pointer.push(performance.now() - start);
            start = performance.now();
            await render(moving ? i : 0);
            submit.push(performance.now() - start);
            await gpu.idle();
            complete.push(performance.now() - start);
            searches.push(renderer.stats().hoverMs);
            states.add(renderer.stats().hover);
          }
          assert(renderer.stats().pickingBytes === 0, 'Automatic hover allocated spatial trees');
          assert(fixture.linksQueries === beforeLinks, 'Hover requeried connectivity');
          results.push({
            projection,
            coordinates: moving ? 'recording XYZ' : 'static',
            hover,
            vertices: count,
            edges: fixture.from.length,
            samples: pointer.length,
            setPointerMedianMs: median(pointer),
            setPointerP95Ms: percentile(pointer, 0.95),
            submitMedianMs: median(submit),
            completeMedianMs: median(complete),
            completeP95Ms: percentile(complete, 0.95),
            latestSearchMs: renderer.stats().hoverMs,
            maxSearchMs: Math.max(...searches),
            states: [...states],
            pickingBytes: renderer.stats().pickingBytes,
            sourceQueries: fixture.queries - beforeQueries,
            connectivityQueries: fixture.linksQueries - beforeLinks,
          });
        }
      }
    }
    return results;
  } finally {
    renderer.destroy();
    target.destroy();
    await gpu.idle();
    gpu.trim();
    view?.resume();
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
    renderer = createNetwork({
      gpu,
      data: data(fixture, false),
      options: { msaa: 1, vertexRadiusPx: 8, daylight: false },
    });
  const target = createRenderTarget({ gpu, width: 256, height: 256 });
  const readback = gpu.buffer({
    size: 256 * 256 * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    device.pushErrorScope('validation');
    await gpu.render({
      timeMs: 0,
      views: [{ renderer, target, at: 0 }],
      encode(encoder) {
        encoder.copyTextureToBuffer(
          { texture: target.texture() },
          { buffer: readback.buffer, bytesPerRow: 1024 },
          [256, 256],
        );
      },
    });
    await readback.buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.buffer.getMappedRange());
    let bright = 0;
    for (let i = 0; i < bytes.length; i += 4) if (bytes[i + 1] > 80 || bytes[i + 2] > 100) bright++;
    assert(bright > 400, 'Graph did not produce visible pixels');
    readback.buffer.unmap();
    const item = { kind: 'vertex', source: fixture, index: fixture.index('node'), row: 12 },
      point = renderer.locate(item);
    assert(point, 'Native vertex could not be located');
    const hits = renderer.hitTest(point);
    assert(hits[0]?.kind === 'vertex' && hits[0]?.row === 12, 'Picking lost physical row identity');
    renderer.setCamera({ projection: 'tilt', pitch: 45 });
    await gpu.render({ timeMs: 0, views: [{ renderer, target, at: 1 }] });
    const tilt = renderer.locate(item);
    assert(renderer.hitTest(tilt)[0]?.row === 12, 'Tilt picking differs from geometry');
    const links = fixture.linksQueries;
    renderer.setVertex('node', {
      position: { x: 'x', y: 'y' },
      height: { field: 'z', domain: [0, 1] },
    });
    await gpu.render({ timeMs: 0, views: [{ renderer, target, at: 2 }] });
    const moving = renderer.locate(item);
    assert(
      Math.hypot(moving[0] - tilt[0], moving[1] - tilt[1]) > 1,
      'Recording positions did not move the vertex',
    );
    assert(
      renderer.hitTest(moving).some((hit) => hit.kind === 'vertex' && hit.row === item.row),
      'Sampled position picking lost row identity',
    );
    assert(fixture.linksQueries === links, 'Changing recording channels requeried connectivity');
    const error = await device.popErrorScope();
    assert(!error, error?.message);
    checks.push(
      'Real GPU pixels',
      'Native identity picking',
      'Tilt projection',
      'Small native blocks / cross-page fields',
      'Sampled X / Y / Z position and picking',
      'Recording channels preserve connectivity',
    );
  } finally {
    readback.destroy();
    renderer.destroy();
    target.destroy();
  }
  const features = featureSource(),
    featureTarget = createRenderTarget({ gpu, width: 512, height: 512 });
  const featureRenderer = createNetwork({
    gpu,
    data: {
      source: features,
      coordinates: 'geographic',
      vertices: { node: { position: 'position', labels: { field: 'name', maxCount: 4 } } },
      edges: {
        route: {
          connectivity: { kind: 'endpoints', layout: 'pair' },
          curve: 'geodesic',
          labels: { field: 'name' },
        },
        star: { connectivity: { kind: 'endpoints', layout: 'star' } },
        bend: { connectivity: { kind: 'endpoints', layout: 'pair' }, bends: 'points' },
      },
      paths: { seam: { points: 'points', pickable: true } },
    },
    camera: { centerX: -30, centerY: 5, scale: 3 },
    options: { edgeWidthPx: 3 },
  });
  try {
    device.pushErrorScope('validation');
    for (const projection of ['flat', 'tilt', 'globe']) {
      featureRenderer.setCamera({ projection, pitch: projection === 'tilt' ? 40 : 0 });
      await gpu.render({
        timeMs: 0,
        views: [{ renderer: featureRenderer, target: featureTarget }],
      });
      const item = { kind: 'edge', source: features, index: features.index('route'), row: 0 },
        point = featureRenderer.locate(item);
      assert(
        point && featureRenderer.hitTest(point).some((hit) => hit.index.type === 'route'),
        'Geodesic picking failed in ' + projection,
      );
    }
    const star = { kind: 'edge', source: features, index: features.index('star'), row: 0 };
    assert(
      featureRenderer.neighborhood(star).filter((item) => item.kind === 'vertex').length === 4,
      'Star adjacency lost endpoints',
    );
    featureRenderer.select(star);
    await gpu.render({ timeMs: 0, views: [{ renderer: featureRenderer, target: featureTarget }] });
    const error = await device.popErrorScope();
    assert(!error, error?.message);
    checks.push(
      'Adaptive GPU geodesics and matching picking',
      'Native bends / complete star adjacency',
      'Shared vertex and edge text anchors',
    );
  } finally {
    featureRenderer.destroy();
    featureTarget.destroy();
  }
  const seamSource = new PathSource(
    {
      node: { position: vectors([170, 20, -170, 20]) },
      route: { dashed: { kind: 'boolean', offset: 0, length: 1, values: Uint8Array.of(1) } },
    },
    {
      route: [
        [
          ['node', 0],
          ['node', 1],
        ],
      ],
    },
  );
  const seamRenderer = createNetwork({
    gpu,
    data: {
      source: seamSource,
      coordinates: 'geographic',
      vertices: { node: { position: 'position' } },
      edges: { route: { connectivity: { kind: 'endpoints', layout: 'pair' }, curve: 'geodesic' } },
    },
    camera: { centerX: 0, centerY: 20, scale: 1.2 },
    options: {
      vertices: false,
      earthAxis: false,
      edgeBaseColor: [1, 1, 1, 1],
      backgroundColor: [0, 0, 0, 1],
      surfaceColor: [0, 0, 0, 1],
      edgeWidthPx: 2,
      dashPeriodPx: 8,
      msaa: 1,
    },
  });
  const seamTarget = createRenderTarget({ gpu, width: 512, height: 512, format: 'rgba8unorm' });
  const pixels = gpu.buffer({
    size: 512 * 512 * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    device.pushErrorScope('validation');
    const counts = [];
    for (const dash of [null, 'dashed']) {
      seamRenderer.setEdge('route', { dash });
      await gpu.render({
        timeMs: 0,
        views: [{ renderer: seamRenderer, target: seamTarget }],
        encode(encoder) {
          encoder.copyTextureToBuffer(
            { texture: seamTarget.texture() },
            { buffer: pixels.buffer, bytesPerRow: 2048 },
            [512, 512],
          );
        },
      });
      await pixels.buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(pixels.buffer.getMappedRange());
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
      pixels.buffer.unmap();
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
    checks.push('Dashed geodesic seam pixels / hidden endpoint markers');
  } finally {
    pixels.destroy();
    seamRenderer.destroy();
    seamTarget.destroy();
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
  else network.setCamera({ projection: 'flat', pitch: 0, fit: true });
};
el('tilt').onclick = () => network.setCamera({ projection: 'tilt', pitch: 50, fit: false });
el('globe').onclick = () => {
  if (source instanceof GraphSource) show(Number(el('size').value), true);
  else network.setCamera({ projection: 'globe', pitch: 0, fit: false });
};
el('fit').onclick = () => network.fit({ animate: true });
el('orbit').onclick = () => network.orbit(!network.orbiting);
el('labels').onclick = () => {
  labelled = !labelled;
  network.setVertex('node', {
    labels: labelled ? { field: 'name', size: 11, maxCount: 45 } : null,
  });
};
el('time').oninput = () => {
  at = Number(el('time').value);
  el('time-value').textContent = at + ' s';
  view.request({ at });
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
el('poles').onchange = () => network.setOptions({ poles: el('poles').checked });
el('hover-mode').onchange = () => network.setOptions({ hover: el('hover-mode').value });
el('hover-budget').onchange = () => {
  if (el('hover-budget').reportValidity())
    network.setOptions({ hoverBudgetMs: Number(el('hover-budget').value) });
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
  detach?.();
  view?.destroy();
  network?.destroy();
  source = featureSource();
  geographic = true;
  network = createNetwork({
    gpu,
    data: {
      source,
      coordinates: 'geographic',
      vertices: { node: { position: 'position', labels: { field: 'name' } } },
      edges: {
        bend: {
          connectivity: { kind: 'endpoints', layout: 'pair' },
          bends: 'points',
          labels: { field: 'name' },
        },
        star: { connectivity: { kind: 'endpoints', layout: 'star' }, labels: { field: 'name' } },
        route: {
          connectivity: { kind: 'endpoints', layout: 'pair' },
          curve: el('geodesic').checked ? 'geodesic' : 'linear',
          labels: { field: 'name' },
        },
      },
      paths: {
        ...(el('borders').checked
          ? {
              border: {
                source: borders,
                points: 'points',
                widthPx: 0.8,
                baseColor: [0.3, 0.48, 0.58, 0.75],
              },
            }
          : {}),
        seam: { points: 'points', pickable: true, widthPx: 2, baseColor: [1, 0.6, 0.25, 1] },
      },
    },
    camera: { centerX: -35, centerY: 5, scale: 4, projection: 'globe', pitch: 0 },
    options: {
      poles: el('poles').checked,
      hover: el('hover-mode').value,
      hoverBudgetMs: Number(el('hover-budget').value),
      edgeBaseColor: [0.95, 0.67, 0.25, 1],
      edgeWidthPx: 2,
      graticule: true,
    },
  });
  network.on('select', (item) => {
    el('status').textContent = item
      ? item.kind + ' / ' + item.index.type + ' / row ' + item.row
      : 'Geometry features';
  });
  view = createCanvasView({
    gpu,
    canvas: el('graph'),
    renderer: network,
    onError: fail,
    onRendered: update,
  });
  detach = attachNetworkInput({ canvas: el('graph'), network });
  view.request({ at: 0 });
  el('status').textContent = 'Bends, four-way junction, geodesic, borders and shared labels';
}
async function benchmarkPaths(count = 100000, moving = false) {
  view?.pause();
  const borders = await loadBorders(),
    fixture = new GraphSource(count, 4096, true),
    results = [];
  const target = createRenderTarget({ gpu, width: 1200, height: 700, format: 'rgba8unorm' });
  try {
    for (const curve of ['linear', 'geodesic'])
      for (const detailed of [false, true]) {
        const input = data(fixture, false);
        input.edges.line.curve = curve;
        if (moving) {
          input.vertices.node.position = { x: 'x', y: 'y' };
          input.vertices.node.height = { field: 'z', domain: [0, 1] };
        }
        input.paths = detailed
          ? { border: { source: borders, points: 'points', widthPx: 0.8 } }
          : undefined;
        const renderer = createNetwork({
          gpu,
          data: input,
          camera: { centerX: -65, centerY: 5, scale: 4, projection: 'globe', pitch: 15 },
          options: { hover: 'auto', poles: false, vertexRadiusPx: 1.4, edgeWidthPx: 0.5, msaa: 4 },
        });
        const draw = async (i) => {
          renderer.setCamera({ bearing: i * 0.3 });
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
            curve,
            moving,
            detailedBorders: detailed,
            vertices: count,
            coldMs: cold[1],
            submitMedianMs: submit[8],
            completeMedianMs: sorted[8],
            completeP95Ms: sorted[15],
            cameraQueries: fixture.queries + borders.queries - queries,
            cameraUploadedBytes: gpu.stats().uploadedBytes - before.uploadedBytes,
            stats: renderer.stats(),
          });
        } finally {
          renderer.destroy();
          await gpu.idle();
          gpu.trim();
        }
      }
  } finally {
    target.destroy();
    view?.resume();
  }
  return results;
}
el('geodesic').onchange = () => {
  if (!geographic) show(Number(el('size').value), true);
  else if (source instanceof GraphSource)
    network.setEdge('line', { curve: el('geodesic').checked ? 'geodesic' : 'linear' });
  else network.setEdge('route', { curve: el('geodesic').checked ? 'geodesic' : 'linear' });
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
