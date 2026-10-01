/* global document */
import { createGpu, createCanvasView, createRenderTarget, colormaps } from '@latkit/gpu';
import { createMonitor, attachMonitorInput } from '@latkit/monitor_new';
import { verify, benchmark } from './verify.js';
import { SignalSource } from './generated/fixture.js';
const canvas = document.querySelector('canvas'),
  status = document.querySelector('#status');
globalThis.monitorCheck = (async () => {
  const gpu = await createGpu();
  const errors = [];
  gpu.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  status.textContent = 'Checking native pixels and benchmarking...';
  const checks = await verify(gpu),
    benchmarks = await benchmark(gpu);
  let source = new SignalSource(64, 4096, { native: true });
  const monitor = createMonitor({
    gpu,
    data: {
      source,
      window: { kind: 'range', between: [0, 41] },
      traces: {
        signal: {
          from: 'signal',
          field: 'value',
          color: { field: 'weight', domain: [0, 63], colormap: colormaps.viridis },
          widthPx: 1.1,
        },
      },
    },
    options: {
      valueDomain: [-1.4, 1.4],
      coordinateAxis: { label: 'Coordinate' },
      valueAxis: { label: 'Value' },
    },
    limits: { historyBytes: 96 * 1024 ** 2 },
  });
  const target = createRenderTarget({ gpu, width: 960, height: 480, format: 'rgba8unorm' });
  const began = performance.now();
  await gpu.render({ views: [{ renderer: monitor, target }], timeMs: 0, completion: 'complete' });
  await gpu.idle();
  const result = {
    checks,
    benchmarks,
    initialMs: performance.now() - began,
    stats: monitor.stats(),
    gpu: gpu.stats(),
    reads: source.reads,
    errors,
  };
  if (errors.length) throw new Error(errors.join('\n'));
  target.destroy();
  const view = createCanvasView({
    gpu,
    canvas,
    renderer: monitor,
    onError: (error) => {
      status.textContent = String(error);
      console.error(error);
    },
    onRendered: () => {
      status.textContent = monitor.stats().refining ? 'Refining history...' : 'Ready';
    },
  });
  attachMonitorInput({ monitor, canvas });
  monitor.on('hover', (reading) => {
    document.querySelector('#reading').textContent = reading
      ? `Row ${reading.row} | frame ${reading.frame} | coordinate ${reading.coordinate.toPrecision(9)} | value ${reading.value.toPrecision(9)}`
      : 'Hover to inspect an exact observation.';
  });
  document.querySelector('#fit').onclick = () => monitor.fit();
  document.querySelector('#clear').onclick = () => monitor.select(null);
  document.querySelector('#append').onclick = () => source.append(32);
  document.querySelector('#axes').onchange = (event) =>
    monitor.setOptions({
      coordinateAxis: event.target.checked ? { label: 'Coordinate' } : null,
      valueAxis: event.target.checked ? { label: 'Value' } : null,
    });
  document.querySelector('#palette').onchange = (event) =>
    monitor.setTrace('signal', {
      color: {
        field: 'weight',
        domain: [0, Math.max(1, source.count - 1)],
        colormap: colormaps[event.target.value],
      },
    });
  document.querySelector('#workload').onchange = (event) => {
    const value = event.target.value;
    source = new SignalSource(
      value === 'many' ? 100000 : value === 'long' ? 1 : value === 'gaps' ? 8 : 64,
      value === 'many' ? 32 : value === 'long' ? 1000000 : value === 'gaps' ? 512 : 4096,
      { native: true, gaps: value === 'gaps', duplicates: value === 'gaps' },
    );
    monitor.setData({
      source,
      window: { kind: 'range', between: [0, source.coordinate(source.frames + 31)] },
      traces: {
        signal: {
          from: 'signal',
          field: 'value',
          color: {
            field: 'weight',
            domain: [0, Math.max(1, source.count - 1)],
            colormap: colormaps[document.querySelector('#palette').value],
          },
          widthPx: value === 'many' ? 0.7 : 1.1,
        },
      },
    });
  };
  document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
  globalThis.fixture = { gpu, monitor, view, source };
  return result;
})().catch((error) => {
  status.textContent = String(error);
  console.error(error);
  throw error;
});
