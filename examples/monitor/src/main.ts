import { createGpu, colormaps, colormapCss, type ColormapName, type Shade } from '@latkit/gpu';
import { createMonitor, type Monitor, type Reading, type Trace } from '@latkit/monitor';
import { Telemetry } from './source.js';
import './style.css';

const ELEMENT_COUNT = 192;
const FRAME_COUNT = 900;
const DT_SECONDS = 0.1;
const HOT_COUNT = 12;

const SIGNALS = [
  {
    id: 'temperature',
    label: 'temperature',
    unit: 'C',
    range: [35, 115],
    decimals: 1,
    lowIsHot: false,
  },
  { id: 'vibration', label: 'vibration', unit: 'g', range: [0, 1.6], decimals: 2, lowIsHot: false },
  { id: 'voltage', label: 'voltage', unit: 'V', range: [11.2, 12.8], decimals: 2, lowIsHot: true },
  { id: 'loss', label: 'packet loss', unit: '%', range: [0, 80], decimals: 1, lowIsHot: false },
] as const;

const EXAMPLE_COLORMAPS = [
  'viridis',
  'turbo',
  'magma',
  'icefire',
] as const satisfies readonly ColormapName[];

type SignalIndex = 0 | 1 | 2 | 3;

interface HotElement {
  readonly element: number;
  readonly value: number;
  readonly score: number;
}

const app = document.getElementById('app') as HTMLElement;
const stage = document.getElementById('monitor-stage') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;
const signalRow = document.getElementById('signals') as HTMLElement;
const colormapRow = document.getElementById('colormaps') as HTMLElement;
const hotList = document.getElementById('hot-list') as HTMLElement;
const selectedEl = document.getElementById('selected') as HTMLElement;
const hoverReadout = document.getElementById('hover-readout') as HTMLElement;
const pickReadout = document.getElementById('pick-readout') as HTMLElement;
const runToggle = document.getElementById('run-toggle') as HTMLButtonElement;
const resetButton = document.getElementById('reset') as HTMLButtonElement;
const autoRangeInput = document.getElementById('auto-range') as HTMLInputElement;
const windowInput = document.getElementById('time-window') as HTMLInputElement;
const rateInput = document.getElementById('rate') as HTMLInputElement;
const rateValue = document.getElementById('rate-value') as HTMLOutputElement;

let seed = 0x5eed1234;
const SIGNAL_IDS = SIGNALS.map((signal) => signal.id);

let source = new Telemetry(SIGNAL_IDS, ELEMENT_COUNT, DT_SECONDS);
let palette: ColormapName = EXAMPLE_COLORMAPS[0];
let monitor: Monitor;
let frameCursor = 0;
let latest = new Float64Array(ELEMENT_COUNT * SIGNALS.length).fill(NaN);
let currentSignal: SignalIndex = 0;
let selectedElement: number | null = null;
let running = true;
let timer: number | null = null;
let lastHotRender = 0;

/** Seconds of history the sliding window shows. */
const WINDOW_S = 20;
const FULL_WINDOW = [0, FRAME_COUNT * DT_SECONDS] as const;

const highlight: Shade = {
  wgsl: `fn shade(f: ShadeFragment) -> vec4f {
    let domain = shadeContext.parameters[0];
    let high = smoothstep(0.55, 0.85, (f.value - domain.x) / (domain.y - domain.x));
    return vec4f(mix(f.color.rgb, vec3f(1.0, 0.4, 0.15), high * 0.85), f.color.a);
  }`,
  tick: (parameters) => {
    parameters.set(signalRange(currentSignal));
    return false;
  },
};

function trace(): Trace {
  const signal = SIGNALS[currentSignal];
  return {
    from: 'sensor',
    field: signal.id,
    widthPx: 1.4,
    color: { field: signal.id, domain: signal.range, colormap: palette },
    shade: signal.id,
  };
}

const phase = new Float32Array(ELEMENT_COUNT);
const band = new Float32Array(ELEMENT_COUNT);
const drift = new Float32Array(ELEMENT_COUNT);
const anomaly = new Float32Array(ELEMENT_COUNT);

for (let element = 0; element < ELEMENT_COUNT; element++) {
  phase[element] = rand() * Math.PI * 2;
  band[element] = element / ELEMENT_COUNT;
  drift[element] = rand() * 2 - 1;
}

function fail(message: string): void {
  app.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML =
    `<h2>Cannot render</h2><p>${message}</p>` +
    '<p class="hint">This example needs a browser with WebGPU support.</p>';
  app.appendChild(box);
}

async function main(): Promise<void> {
  const gpu = await createGpu();
  monitor = createMonitor(gpu, {
    canvas: stage,
    source,
    traces: { telemetry: trace() },
    camera: { window: FULL_WINDOW, values: signalRange(currentSignal) },
    coordinateAxis: 'Time (s)',
    valueAxis: { label: 'Temperature (C)', precision: 1 },
    unselectedAlpha: 0.35,
  });
  monitor.on('error', (error) => {
    setRunning(false);
    statusEl.textContent = String(error);
  });
  monitor.on('hover', (reading) => {
    hoverReadout.textContent = describeReading(reading);
  });
  monitor.on('select', (readings) => {
    const reading = readings[0] ?? null;
    selectedElement = reading?.row ?? null;
    pickReadout.textContent = describeReading(reading);
    renderSelected();
    renderHotList(performance.now(), true);
  });
  wireChrome();
  resetStream();
  setRunning(true);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    stopTimer();
    monitor.destroy();
    void source.close();
    gpu.destroy();
  });
}

function wireChrome(): void {
  for (let i = 0; i < SIGNALS.length; i++) {
    const spec = SIGNALS[i]!;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = spec.label;
    button.className = 'segment';
    button.setAttribute('aria-pressed', String(i === currentSignal));
    button.addEventListener('click', () => setSignal(i as SignalIndex));
    signalRow.appendChild(button);
  }

  for (let i = 0; i < EXAMPLE_COLORMAPS.length; i++) {
    const name = EXAMPLE_COLORMAPS[i]!;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.title = colormaps[name].label ?? name;
    button.setAttribute('aria-label', colormaps[name].label ?? name);
    button.setAttribute('aria-pressed', String(i === 0));
    button.style.setProperty('--swatch', colormapCss(colormaps[name], { direction: 'to right' }));
    button.addEventListener('click', () => {
      palette = name;
      monitor.set({ traces: { telemetry: trace() } });
      setActive(colormapRow, button);
    });
    colormapRow.appendChild(button);
  }

  document.getElementById('fit')!.addEventListener('click', () => {
    autoRangeInput.checked = true;
    windowInput.checked = false;
    applyRange();
    applyWindow();
  });
  document.getElementById('shade')!.addEventListener('change', (event) => {
    monitor.set({ shade: (event.target as HTMLInputElement).checked ? highlight : null });
  });
  runToggle.addEventListener('click', () => setRunning(!running));
  resetButton.addEventListener('click', resetStream);
  autoRangeInput.addEventListener('change', applyRange);
  windowInput.addEventListener('change', applyWindow);
  rateInput.addEventListener('input', () => {
    rateValue.value = `${rateInput.value} hz`;
    if (running) restartTimer();
  });
}

function resetStream(): void {
  anomaly.fill(0);
  frameCursor = 0;
  const previous = source;
  source = new Telemetry(SIGNAL_IDS, ELEMENT_COUNT, DT_SECONDS);
  latest = new Float64Array(ELEMENT_COUNT * SIGNALS.length).fill(NaN);
  selectedElement = null;
  hoverReadout.textContent = '-';
  pickReadout.textContent = '-';
  monitor.set({ source, traces: { telemetry: trace() } });
  void previous.close();
  monitor.select([]);
  // Show useful history immediately, then append one native frame per timer tick.
  for (let frame = 0; frame < 40; frame++) {
    writeFrame(frame);
    source.append(latest);
    frameCursor++;
  }
  applyWindow();
  applyRange();
  renderSelected();
  renderHotList(performance.now(), true);
  updateStatus();
}

function setSignal(signal: SignalIndex): void {
  if (signal === currentSignal) return;
  currentSignal = signal;
  monitor.set({ traces: { telemetry: trace() } });
  applyRange();
  selectedElement = null;
  monitor.select([]);
  pickReadout.textContent = '-';
  for (const [index, button] of [...signalRow.querySelectorAll('button')].entries()) {
    button.setAttribute('aria-pressed', String(index === signal));
  }
  renderSelected();
  renderHotList(performance.now(), true);
}

function setRunning(next: boolean): void {
  running = next;
  runToggle.querySelector('span')!.textContent = running ? 'II' : '>';
  runToggle.setAttribute('aria-label', running ? 'Pause stream' : 'Resume stream');
  runToggle.title = running ? 'Pause stream' : 'Resume stream';
  if (running) {
    restartTimer();
  } else {
    stopTimer();
  }
  updateStatus();
}

function restartTimer(): void {
  stopTimer();
  const hz = Number(rateInput.value);
  timer = window.setInterval(() => tick(), Math.max(16, Math.round(1000 / hz)));
}

function stopTimer(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

function tick(): void {
  if (frameCursor >= FRAME_COUNT) resetStream();
  writeFrame(frameCursor);
  frameCursor++;
  source.append(latest);
  const now = performance.now();
  renderHotList(now);
  if (selectedElement !== null) renderSelected();
  updateStatus();
}

function writeFrame(frame: number): void {
  latest = new Float64Array(ELEMENT_COUNT * SIGNALS.length);
  const time = frame * DT_SECONDS;
  for (let element = 0; element < ELEMENT_COUNT; element++) {
    const b = band[element]!;
    const p = phase[element]!;
    const d = drift[element]!;
    const oldAnomaly = anomaly[element]!;
    const triggered = rand() < 0.00075 ? 0.65 + rand() * 0.45 : 0;
    const a = Math.max(triggered, oldAnomaly * 0.972 - 0.001);
    anomaly[element] = a;

    const load = 0.5 + 0.5 * Math.sin(time * 0.19 + b * 7.4);
    const ripple = Math.sin(time * 0.73 + p) * 0.5 + Math.sin(time * 0.11 + p * 0.4) * 0.5;
    const jitter = rand() - 0.5;

    setValue(0, frame, element, 58 + b * 22 + ripple * 6 + load * 5 + a * 28 + jitter * 1.2);
    setValue(
      1,
      frame,
      element,
      0.16 + load * 0.28 + Math.abs(ripple) * 0.18 + a * 0.92 + rand() * 0.04,
    );
    setValue(2, frame, element, 12.24 + d * 0.16 + ripple * 0.09 - a * 0.58 + jitter * 0.035);
    setValue(3, frame, element, Math.max(0, 0.6 + load * 5.5 + a * 62 + rand() * 1.8));
  }
}

function setValue(signal: number, _frame: number, element: number, value: number): void {
  latest[signal * ELEMENT_COUNT + element] = value;
}

function valueAt(signal: number, _frame: number, element: number): number {
  return latest[signal * ELEMENT_COUNT + element]!;
}

function applyRange(): void {
  const signal = SIGNALS[currentSignal];
  monitor.set({
    camera: autoRangeInput.checked ? { fit: true } : { values: signalRange(currentSignal) },
    valueAxis: { label: `${signal.label} (${signal.unit})`, precision: signal.decimals },
  });
}

/** Follow is renderer-owned; appending never resets data or rebuilds bindings. */
function applyWindow(): void {
  const end = Math.max(DT_SECONDS, (frameCursor - 1) * DT_SECONDS);
  monitor.set({
    camera: windowInput.checked
      ? { window: [Math.max(0, end - WINDOW_S), end], follow: WINDOW_S }
      : { window: FULL_WINDOW, follow: null },
  });
}

function signalRange(signal: SignalIndex): readonly [number, number] {
  return SIGNALS[signal].range;
}

function renderHotList(now: number, force = false): void {
  if (!force && now - lastHotRender < 220) return;
  lastHotRender = now;
  const hot = rankHotElements();
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < hot.length; index++) {
    const item = hot[index]!;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hot-item';
    button.setAttribute('aria-pressed', String(item.element === selectedElement));
    button.addEventListener('click', () => {
      selectedElement = item.element;
      monitor.select([
        { source, index: source.index, row: item.element, field: SIGNALS[currentSignal].id },
      ]);
      pickReadout.textContent = describeElement(item.element);
      renderSelected();
      renderHotList(performance.now(), true);
    });

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'element';
    name.textContent = `element ${item.element}`;
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = formatValue(item.value, currentSignal);
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.inlineSize = `${Math.round(item.score * 100)}%`;
    bar.appendChild(fill);

    button.append(rank, name, value, bar);
    fragment.appendChild(button);
  }
  hotList.replaceChildren(fragment);
}

function rankHotElements(): HotElement[] {
  const frame = frameCursor - 1;
  if (frame < 0) return [];
  const out: HotElement[] = [];
  for (let element = 0; element < ELEMENT_COUNT; element++) {
    const value = valueAt(currentSignal, frame, element);
    out.push({ element, value, score: heatScore(value, currentSignal) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, HOT_COUNT);
}

function heatScore(value: number, signal: SignalIndex): number {
  const spec = SIGNALS[signal];
  const [min, max] = spec.range;
  const t = (value - min) / (max - min);
  return clamp01(spec.lowIsHot ? 1 - t : t);
}

function renderSelected(): void {
  selectedEl.textContent = selectedElement === null ? 'none' : describeElement(selectedElement);
}

function describeElement(element: number): string {
  const frame = frameCursor - 1;
  if (frame < 0) return `element ${element}`;
  return `element ${element} / ${formatValue(valueAt(currentSignal, frame, element), currentSignal)}`;
}

function describeReading(reading: Reading | null): string {
  if (!reading) return '-';
  return `element ${reading.row} / ${formatValue(reading.value, SIGNALS.findIndex((signal) => signal.id === reading.field) as SignalIndex)} / ${reading.coordinate.toFixed(1)}s`;
}

function formatValue(value: number, signal: SignalIndex): string {
  const spec = SIGNALS[signal];
  return `${value.toFixed(spec.decimals)} ${spec.unit}`;
}

function updateStatus(): void {
  const state = running ? 'streaming' : 'paused';
  statusEl.textContent = `${state} / ${frameCursor.toLocaleString()} frames / ${ELEMENT_COUNT} elements`;
}

function setActive(row: HTMLElement, active: HTMLButtonElement): void {
  for (const button of row.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === active));
  }
}

function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
