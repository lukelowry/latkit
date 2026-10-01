/* global document, location */
import { createGpu, createCanvasView, colormaps } from '@latkit/gpu';
import { createMonitor, attachMonitorInput } from '@latkit/monitor';
import { verify, benchmark, canvasLatency } from './verify.js';
import { SignalSource } from './generated/fixture.js';
const canvas = document.querySelector('canvas'),
  status = document.querySelector('#status');
globalThis.monitorCheck = (async () => {
  const gpu = await createGpu();
  const errors = [];
  gpu.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const began = performance.now();
  status.textContent = 'Loading signals...';
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
  let firstVisibleMs, readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const view = createCanvasView({
    gpu,
    canvas,
    renderer: monitor,
    onError: (error) => {
      status.textContent = String(error);
      console.error(error);
    },
    onRendered: () => {
      if (monitor.stats().visible && firstVisibleMs === undefined)
        firstVisibleMs = performance.now() - began;
      status.textContent = monitor.stats().refining ? 'Adding signals...' : 'Ready';
      if (!monitor.stats().refining) readyResolve();
    },
  });
  attachMonitorInput({ monitor, canvas });
  monitor.on('hover', (reading) => {
    document.querySelector('#reading').textContent = reading
      ? `Row ${reading.row} | frame ${reading.frame} | coordinate ${reading.coordinate.toPrecision(9)} | value ${reading.value.toPrecision(9)}`
      : 'Hover to inspect an exact observation.';
  });
  document.querySelector('#reset').onclick = () =>
    monitor.setWindow({ kind: 'range', between: [0, source.coordinate(source.frames + 31)] });
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

  globalThis.fixture = {
    gpu,
    monitor,
    view,
    get source() {
      return source;
    },
  };
  const streamButton = document.querySelector('#stream');
  let streaming;
  streamButton.onclick = () => {
    if (streaming) {
      clearInterval(streaming);
      streaming = undefined;
      streamButton.textContent = 'Start stream';
      return;
    }
    source = new SignalSource(8, 0, { native: true });
    monitor.setData({
      source,
      window: { kind: 'range', between: [0, 10] },
      traces: {
        signal: {
          from: 'signal',
          field: 'value',
          color: { field: 'weight', domain: [0, 7], colormap: colormaps.viridis },
        },
      },
    });
    streaming = setInterval(() => source.append(1), 20);
    streamButton.textContent = 'Stop stream';
  };
  await ready;
  const startup = { firstVisibleMs, completeMs: performance.now() - began };
  const runChecks = async () => {
    const result = {
      startup,
      checks: await verify(gpu),
      benchmarks: await benchmark(gpu),
      canvas: await canvasLatency(gpu),
      errors,
    };
    if (errors.length) throw new Error(errors.join('\n'));
    document.querySelector('#results').textContent = JSON.stringify(result, null, 2);
    status.textContent = 'Ready';
    return result;
  };
  document.querySelector('#checks').onclick = () =>
    void runChecks().catch((error) => {
      status.textContent = String(error);
    });
  document.querySelector('#results').textContent = JSON.stringify({ startup }, null, 2);
  if (new URL(location.href).searchParams.has('test')) return runChecks();
  return { startup };
})().catch((error) => {
  status.textContent = String(error);
  console.error(error);
  throw error;
});
