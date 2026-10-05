/* global document, location */
import { createGpu } from '@latkit/gpu';
import { createMonitor } from '@latkit/monitor';
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
  const monitor = createMonitor(gpu, {
    canvas,
    source: source.data,
    traces: {
      signal: {
        from: 'signal',
        y: 'value',
        color: { field: 'weight', domain: [0, 63], colormap: 'viridis' },
        widthPx: 1.1,
      },
    },
    camera: { window: [0, 41], values: [-1.4, 1.4] },
    coordinateAxis: 'Coordinate',
    valueAxis: 'Value',
    limits: { historyBytes: 96 * 1024 ** 2 },
  });
  monitor.on('error', (error) => {
    status.textContent = String(error);
    console.error(error);
  });
  let firstVisibleMs, readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  monitor.on('frame', () => {
    const stats = monitor.stats();
    if (stats.visible && firstVisibleMs === undefined) firstVisibleMs = performance.now() - began;
    status.textContent = stats.refining ? 'Adding signals...' : 'Ready';
    if (!stats.refining) readyResolve();
  });
  monitor.on('hover', (reading) => {
    document.querySelector('#reading').textContent = reading
      ? `Row ${reading.row} | frame ${reading.frame} | coordinate ${reading.coordinate.toPrecision(9)} | value ${reading.value.toPrecision(9)}`
      : 'Hover to inspect an exact observation.';
  });
  document.querySelector('#reset').onclick = () =>
    monitor.set({ camera: { window: [0, source.coordinate(source.frames + 31)] } });
  document.querySelector('#clear').onclick = () => monitor.select([]);
  document.querySelector('#append').onclick = () => {
    source.append(32);
    monitor.set({ source: source.data });
  };
  document.querySelector('#axes').onchange = (event) =>
    monitor.set({
      coordinateAxis: event.target.checked ? 'Coordinate' : false,
      valueAxis: event.target.checked ? 'Value' : false,
    });
  document.querySelector('#palette').onchange = (event) =>
    monitor.set({
      traces: {
        signal: {
          color: {
            field: 'weight',
            domain: [0, Math.max(1, source.count - 1)],
            colormap: event.target.value,
          },
        },
      },
    });
  document.querySelector('#workload').onchange = (event) => {
    const value = event.target.value;
    source = new SignalSource(
      value === 'many' ? 100000 : value === 'long' ? 1 : value === 'gaps' ? 8 : 64,
      value === 'many' ? 32 : value === 'long' ? 1000000 : value === 'gaps' ? 512 : 4096,
      { native: true, gaps: value === 'gaps', duplicates: value === 'gaps' },
    );
    monitor.set({
      source: source.data,
      traces: {
        signal: {
          from: 'signal',
          y: 'value',
          color: {
            field: 'weight',
            domain: [0, Math.max(1, source.count - 1)],
            colormap: document.querySelector('#palette').value,
          },
          widthPx: value === 'many' ? 0.7 : 1.1,
        },
      },
      camera: { window: [0, source.coordinate(source.frames + 31)] },
    });
  };

  globalThis.fixture = {
    gpu,
    monitor,
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
    monitor.set({
      source: source.data,
      traces: {
        signal: {
          from: 'signal',
          y: 'value',
          color: { field: 'weight', domain: [0, 7], colormap: 'viridis' },
          widthPx: null,
        },
      },
      camera: { window: [0, 10] },
    });
    streaming = setInterval(() => {
      source.append(1);
      monitor.set({ source: source.data });
    }, 20);
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
