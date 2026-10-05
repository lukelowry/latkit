import { colormapCss, colormaps, createGpu, type FrameInfo } from '@latkit/gpu';
import { createMonitor, type Trace } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
import { coupledData } from './coupled-data.js';
import './coupled.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const slider = element<HTMLInputElement>('time');
const play = element<HTMLButtonElement>('play');
const reset = element<HTMLButtonElement>('reset');
const speed = element<HTMLSelectElement>('speed');
const traces = element<HTMLSelectElement>('traces');
const status = element('status');
let stopPlayback = () => {};
function fail(error: unknown) {
  stopPlayback();
  const message = element('error');
  message.hidden = false;
  message.textContent = `Rendering failed: ${String(error)}. Reload in a WebGPU-capable browser to retry.`;
  status.textContent = 'Rendering stopped';
  for (const control of [slider, play, reset, speed, traces]) control.disabled = true;
  console.error(error);
}

async function main() {
  const history = coupledData();
  const gpu = await createGpu();
  const color = { field: 'signal', domain: [0, 1], colormap: 'viridis' } as const;
  const network = createNetwork(gpu, {
    canvas: element<HTMLCanvasElement>('network'),
    source: history.data,
    at: 0,
    vertices: {
      Node: {
        x: 'position',
        y: { field: 'position', component: 1 },
        z: { field: 'signal', domain: [0, 1], range: [0, 3] },
        color,
      },
    },
    edges: { Link: { ends: ['from', 'to'] } },
    camera: { projection: 'tilt', pitch: 50, bearing: 20 },
    fitPitch: 50,
    fitBearing: 20,
    fitPaddingPx: [110, 72, 80, 72],
    poles: true,
    earthAxis: false,
    vertexRadiusPx: 3.4,
    edgeWidthPx: 1,
    background: [0.035, 0.047, 0.067, 1],
  });
  const subset = {
    kind: 'indices',
    index: history.index,
    values: Uint32Array.from({ length: 16 }, (_, i) => i * 25 + 10),
  } as const;
  const trace = (all: boolean): Trace => ({
    from: 'Node',
    y: 'signal',
    color,
    widthPx: all ? 0.8 : 1.5,
    ...(all ? {} : { rows: subset }),
  });
  const monitor = createMonitor(gpu, {
    canvas: element<HTMLCanvasElement>('monitor'),
    source: history.data,
    at: 0,
    traces: { signal: trace(false) },
    camera: { x: [0, history.duration], y: [0, 1], fit: false },
    xAxis: 'Time (s)',
    yAxis: 'Signal',
    cursorColor: [1, 0.9, 0.83, 1],
    background: [0.035, 0.047, 0.067, 1],
  });
  for (const view of [network, monitor]) view.on('error', fail);
  element('dataset').textContent =
    `Synthetic | ${history.count} nodes | ${history.edges} edges | ${history.frames.toLocaleString()} samples/node | 60 s`;
  element('palette').style.background = colormapCss(colormaps.viridis, { direction: 'to right' });
  slider.max = String(history.duration);
  let at = 0,
    playing = false,
    animation = 0,
    previousTime = 0,
    lastReadout = 0;
  const measurements = [network, monitor].map((view, i) => {
    const state = { at: NaN, count: 0, frames: [] as number[] };
    view.on('frame', (frame: FrameInfo) => {
      state.at = frame.at ?? NaN;
      state.count++;
      state.frames.push(performance.now());
      if (!playing) readouts(performance.now());
    });
    return { state, output: element(i === 0 ? 'network-metrics' : 'monitor-metrics') };
  });
  function readouts(now: number) {
    for (let i = 0; i < measurements.length; i++) {
      const { state, output } = measurements[i]!;
      while (state.frames.length && state.frames[0]! < now - 1000) state.frames.shift();
      const stats = i === 0 ? network.stats() : monitor.stats();
      const time = Number.isFinite(state.at) ? state.at.toFixed(3) + ' s' : 'waiting';
      output.textContent = `${playing ? state.frames.length + ' FPS' : 'Paused'} | drawn ${time} | prepare ${stats.prepareMs.toFixed(1)} ms | ${state.count} frames`;
      output.dataset.at = String(state.at);
      output.dataset.frames = String(state.count);
      output.dataset.fps = String(state.frames.length);
    }
    const a = measurements[0]!.state.at,
      b = measurements[1]!.state.at;
    const ready = a === at && b === at;
    status.textContent = monitor.stats().refining
      ? 'Preparing trace history...'
      : ready
        ? `Both views at ${at.toFixed(3)} s`
        : a === b
          ? `Views aligned at ${a.toFixed(3)} s`
          : `Catching up | view difference ${Number.isFinite(a - b) ? (Math.abs(a - b) * 1000).toFixed(0) + ' ms' : 'waiting'}`;
    status.dataset.coupled = String(ready);
    lastReadout = now;
  }
  /** One coordinate, one immutable Data value. No server reads or history mutation. */
  function seek(time: number) {
    at = Math.max(0, Math.min(history.duration, time));
    network.set({ at });
    monitor.set({ at });
    slider.value = String(at);
    slider.setAttribute('aria-valuetext', `${at.toFixed(3)} seconds`);
    element<HTMLOutputElement>('time-value').value = at.toFixed(3) + ' s';
  }
  function tick(now: number) {
    if (!playing) return;
    const next = at + ((now - previousTime) / 1000) * Number(speed.value);
    previousTime = now;
    seek(next > history.duration ? next % history.duration : next);
    // Only telemetry text is refreshed at 4 Hz. Rendering follows every animation callback.
    if (now - lastReadout >= 250) readouts(now);
    animation = requestAnimationFrame(tick);
  }
  function setPlaying(value: boolean) {
    playing = value;
    play.textContent = playing ? 'Pause' : 'Play';
    cancelAnimationFrame(animation);
    if (playing) {
      previousTime = performance.now();
      animation = requestAnimationFrame(tick);
    }
    readouts(performance.now());
  }
  stopPlayback = () => setPlaying(false);
  play.addEventListener('click', () => setPlaying(!playing));
  reset.addEventListener('click', () => {
    setPlaying(false);
    seek(0);
  });
  slider.addEventListener('input', () => {
    setPlaying(false);
    seek(Number(slider.value));
  });
  slider.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    setPlaying(false);
    seek(at + (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1) * 0.05);
  });
  traces.addEventListener('change', () =>
    monitor.set({ traces: { signal: trace(traces.value === '400') } }),
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setPlaying(false);
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    cancelAnimationFrame(animation);
    network.destroy();
    monitor.destroy();
    gpu.destroy();
  });
  for (const control of [slider, play, reset, speed, traces]) control.disabled = false;
  seek(15);
}
void main().catch(fail);
