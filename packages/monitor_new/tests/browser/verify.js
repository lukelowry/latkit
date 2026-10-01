import {connect,messagePort,serve} from '@latkit/connect';
/* global document, GPUBufferUsage, GPUMapMode, MessageChannel */
import { createMonitor } from '@latkit/monitor_new';
import { createRenderTarget } from '@latkit/gpu';
import { SignalSource } from './generated/fixture.js';
function assert(value, message) {
  if (!value) throw new Error(message);
}
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
export async function verify(gpu) {
  const checks = [];
  globalThis.pixelChecks = checks;
  const target = createRenderTarget({ gpu, width: 512, height: 256 });
  const render = async (source, extra = {}, trace = {}) => {
    const origin = source.options.valueOrigin ?? 0,
      lo = source.coordinate(0),
      hi = source.coordinate(source.frames - 1);
    const view = createMonitor({
      gpu,
      data: {
        source,
        window: { kind: 'range', between: [lo, hi] },
        traces: {
          a: {
            from: 'signal',
            field: 'value',
            widthPx: 2.5,
            baseColor: [1, 0.25, 0.05, 1],
            ...trace,
          },
        },
      },
      options: {
        coordinateAxis: null,
        valueAxis: null,
        fitPaddingPx: 12,
        valueDomain: [origin - 2, origin + 2],
        backgroundColor: [0, 0, 0, 1],
        ...extra,
      },
    });
    globalThis.checkView = view;
    await gpu.render({ views: [{ renderer: view, target }], timeMs: 10, completion: 'complete' });
    await gpu.idle();
    return {
      view,
      image: await pixels(gpu, target),
      x: (f) => 12 + ((source.coordinate(f) - lo) / (hi - lo)) * 488,
      y: (v) => 12 + ((origin + 2 - v) / 4) * 232,
    };
  };
  for (const mode of ['raw', 'gaps', 'relative', 'envelope', 'fallback', 'relative envelope', 'msaa']) {
    document.querySelector('#status').textContent = 'Pixel check: ' + mode;
    const source = new SignalSource(1, mode === 'envelope' || mode === 'fallback' || mode === 'relative envelope' ? 8192 : 128, {
      native: mode === 'envelope' || mode === 'relative envelope',
      gaps: mode === 'gaps',
      coordinateOrigin: mode.startsWith('relative') ? 2 ** 40 : 0,
      valueOrigin: mode.startsWith('relative') ? 2 ** 40 : 0,
      reverse: mode === 'raw',
      blockFrames: mode === 'raw' ? 7 : 1024,
    });
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
    await source.close();
  }
  for(const interpolation of ['step-before','step-after']){
    const source=new SignalSource(1,2);source.value=(_row,frame)=>frame===0?-0.75:0.75;
    const out=await render(source,{}, {interpolation});const value=interpolation==='step-before'?0.75:-0.75;
    assert(bright(out.image,256,out.y(value),2),interpolation+' does not preserve its step');
    assert(!bright(out.image,256,out.y(-value),2),interpolation+' uses the wrong step orientation');
    out.view.destroy();checks.push({mode:interpolation,passed:true});
  }
  const focusSource=new SignalSource(2,128);focusSource.value=(row)=>row?1:-1;
  const focused=await render(focusSource,{focusColor:[0,1,0,1]});const hits=await focused.view.hitTest([focused.x(64),focused.y(1)],{radiusPx:3,limit:1});
  assert(hits[0]?.row===1&&hits[0].frame===focusSource.firstFrame+64,'Picking lost the exact native observation');focused.view.select(hits[0]);
  await gpu.render({views:[{renderer:focused.view,target}],timeMs:10,completion:'complete'});const focusedPixels=await pixels(gpu,target);
  const ix=Math.round(focused.x(64)),iy=Math.round(focused.y(1)),pixel=iy*focusedPixels.stride+ix*4;
  assert(focusedPixels.data[pixel+1]>100&&focusedPixels.data[pixel]<30,'Focus did not composite the selected row');focused.view.destroy();checks.push({mode:'native focus and picking',passed:true});
  // Sampled visibility must refine raw samples instead of misapplying envelope representatives.
  document.querySelector('#status').textContent = 'Pixel check: visibility';
  const visibility = new SignalSource(1, 4096, { native: true });
  const shown = await render(visibility, {}, { visible: 'visible' });
  assert(
    !visibility.requests.some((q) => q.kind === 'envelope'),
    'Sampled visibility used lossy summaries',
  );
  shown.view.destroy();
  checks.push({ mode: 'sampled visibility', passed: true });
  // A rejected shader never replaces the working pipeline.
  document.querySelector('#status').textContent = 'Pixel check: shade';
  const source = new SignalSource(1, 128);
  const effect = await render(source, {}, { shade: 'value' });
  let rejected = false;
  try {
    await effect.view.setShade({ wgsl: 'not valid WGSL' });
  } catch {
    rejected = true;
  }
  assert(rejected, 'Invalid shade accepted');
  await effect.view.setShade({
    wgsl: 'fn shade(f:ShadeFragment)->vec4f { return vec4f(0.0,1.0,0.0,f.color.a); }',
  });
  await gpu.render({
    views: [{ renderer: effect.view, target }],
    timeMs: 10,
    completion: 'complete',
  });
  const green = await pixels(gpu, target);
  let colored = 0;
  for (let i = 0; i < green.data.length; i += 4)
    if (green.data[i + 1] > 100 && green.data[i] < 20) colored++;
  assert(colored > 100, 'Shared Shade did not affect history');
  effect.view.destroy();
  checks.push({ mode: 'transactional shade', passed: true });
  const channel=new MessageChannel(),local=new SignalSource(3,128);
  const serving=serve(messagePort(channel.port1),local,{kind:'queryable'}),remote=await connect(messagePort(channel.port2),{kind:'queryable'});
  const connected=createMonitor({gpu,data:{source:remote,window:{kind:'range',between:[0,1.27]},traces:{a:{from:'signal',field:'value'}}},options:{valueDomain:[-2,2],coordinateAxis:null,valueAxis:null}});
  try{
    await gpu.render({views:[{renderer:connected,target}],timeMs:0,completion:'complete'});
    const camera=connected.getCamera(),coordinate=local.coordinate(60),value=local.value(1,60);
    const hits=await connected.hitTest([256+(coordinate-camera.center[0])*camera.scale[0],128-(value-camera.center[1])*camera.scale[1]],{radiusPx:0.25,limit:3});
    assert(hits.some(hit=>hit.source===remote&&hit.row===1&&hit.frame===local.firstFrame+60&&hit.value===value),'Connected source changed the native reading contract');
    connected.destroy();assert(!local.closed,'Monitor closed a borrowed connected source');checks.push({mode:'connected Queryable',passed:true});
  }finally{connected.destroy();await remote.close();await serving;channel.port1.close();channel.port2.close();}
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
  const result = [];
  globalThis.benchmarkProgress = result;
  const target = createRenderTarget({ gpu, width: 960, height: 480 });
  for (const [name, rows, frames] of [
    ['many rows', 100000, 32],
    ['long history', 1, 1000000],
    ['signals', 64, 4096],
  ]) {
    const source = new SignalSource(rows, frames, { native: true });
    const view = createMonitor({
      gpu,
      data: {
        source,
        window: { kind: 'range', between: [0, source.coordinate(frames + 32)] },
        traces: {
          signal: { from: 'signal', field: 'value', widthPx: 1, baseColor: [0.2, 0.7, 0.9, 0.15] },
        },
      },
      options: {
        valueDomain: [-1.4, 1.4],
        coordinateAxis: { label: 'Coordinate' },
        valueAxis: { label: 'Value' },
      },
      limits: { historyBytes: 96 * 1024 ** 2 },
    });
    globalThis.benchmarkView = view;
    const progress = { name, phase: 'initial', started: performance.now() };
    result.push(progress);
    document.querySelector('#status').textContent = 'Benchmark: ' + name;
    let prepared = [],
      began = performance.now();
    const finish = gpu.render({
      views: [{ renderer: view, target }],
      timeMs: 0,
      completion: 'complete',
    });
    await finish;
    await gpu.idle();
    const initialMs = performance.now() - began;
    progress.phase = 'steady';
    const reads = source.reads,
      steady = [],
      moving = [];
    for (let i = 0; i < 45; i++) {
      began = performance.now();
      await gpu.render({
        views: [{ renderer: view, target, at: source.coordinate(i) }],
        timeMs: i * 16,
      });
      await gpu.idle();
      if (i >= 5) steady.push(performance.now() - began);
    }
    assert(source.reads === reads, 'Playhead caused history queries');
    progress.phase = 'moving';
    for (let i = 0; i < 25; i++) {
      view.panBy(i % 2 ? 1 : -1, 0);
      began = performance.now();
      await gpu.render({ views: [{ renderer: view, target }], timeMs: i * 16 });
      await gpu.idle();
      moving.push(performance.now() - began);
      prepared.push(view.stats().prepareMs);
    }
    assert(source.reads === reads, 'Moving camera caused history queries');
    await gpu.render({ views: [{ renderer: view, target }], timeMs: 1000, completion: 'complete' });
    progress.phase = 'focus';
    const q = source.requests.length;
    view.select({ source, index: source.index, row: 0, field: 'value' });
    began = performance.now();
    await gpu.render({ views: [{ renderer: view, target }], timeMs: 1000, completion: 'complete' });
    await gpu.idle();
    const focusMs = performance.now() - began;
    assert(
      source.requests
        .slice(q)
        .filter((q) => q.kind === 'samples')
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
      moving: summary(moving),
      prepare: summary(prepared),
      focusMs,
      historyBytes: view.stats().historyBytes,
      gpu: gpu.stats(),
      peakSourceBlockBytes: source.peakBlockBytes,
      noQueriesDuringInteraction: true,
      sourceYieldMs: source.yieldMs,
      sourceYieldCount: source.yieldCount,
      sourceObservations: source.observations,
    });
    view.destroy();
    await source.close();
    await gpu.idle();
    gpu.trim();
  }
  target.destroy();
  return result;
}
