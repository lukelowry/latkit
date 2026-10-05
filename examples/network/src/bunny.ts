import { colormapCss, colormaps, createGpu, type FrameInfo } from '@latkit/gpu';
import { createMonitor } from '@latkit/monitor';
import { createNetwork, type Camera } from '@latkit/network';
import { FLOOR, History } from './bunny-data.js';
import { loadBunny } from './bunny-mesh.js';
import { SoftBody, STEP, type Controls } from './bunny-physics.js';
import './coupled.css';
import './bunny.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('network');
const slider = element<HTMLInputElement>('time');
const status = element('status');
/** Seconds of history the monitor shows. */
const WINDOW = 12;
/** A z of 1 draws one meter high: `zScale` is in 15% of the floor's extent. */
const METERS = 1 / (0.15 * FLOOR * 2);
// Each domain starts below rest, so a bunny at rest draws bright against the dark floor.
const PAINTS = {
  strain: { field: 'strain', domain: [-0.1, 0.35], colormap: 'turbo', unit: 'Strain 0 – 0.35 m' },
  speed: { field: 'speed', domain: [-3, 9], colormap: 'plasma', unit: 'Speed 0 – 9 m/s' },
  height: { field: 'z', domain: [-1.5, 4], colormap: 'viridis', unit: 'Height 0 – 4 m' },
} as const;
type Paint = keyof typeof PAINTS;

let stop = () => {};
function fail(error: unknown) {
  stop();
  const message = element('error');
  message.hidden = false;
  message.textContent = `Rendering failed: ${String(error)}. Reload in a WebGPU-capable browser to retry.`;
  status.textContent = 'Stopped';
  console.error(error);
}

async function main() {
  const [mesh, gpu] = await Promise.all([loadBunny(), createGpu()]);
  const body = new SoftBody(mesh);
  const history = new History(mesh);
  const controls: Controls = { gravity: 9.81, firmness: 0.45, inflate: 1, wind: false };
  body.drop(true);
  const publish = () => {
    const vertices = new Float32Array(mesh.count * 5);
    body.sample(vertices);
    history.append(body.time, vertices, Float32Array.from(body.metrics()));
  };
  publish();

  const color = (paint: Paint) => {
    const { field, domain, colormap } = PAINTS[paint];
    return { field, domain, colormap };
  };
  const network = createNetwork(gpu, {
    canvas,
    source: history.data,
    at: body.time,
    vertices: {
      Floor: { x: 'x', y: 'y', color: [0.42, 0.52, 0.64, 0.5], radiusPx: 1.5 },
      Shadow: { x: 'x', y: 'y', color: [0, 0, 0, 0.16], radiusPx: 3.5 },
      Vertex: {
        x: 'x',
        y: 'y',
        z: { field: 'z', domain: [0, 1], range: [0, 1], clamp: false },
        color: color('strain'),
        radiusPx: { field: 'strain', domain: [0, 0.35], range: [1.6, 4.5] },
      },
    },
    edges: {
      Grid: { ends: ['from', 'to'], color: [0.3, 0.37, 0.47, 0.4], widthPx: 1 },
      Link: { ends: ['from', 'to'] },
    },
    camera: { projection: 'tilt', pitch: 58, bearing: 30, fit: true },
    fitPitch: 58,
    fitBearing: 30,
    fitPaddingPx: [110, 24, 8, 24],
    zScale: METERS,
    edgeWidthPx: 1,
    orbitRate: 0.5,
    hover: 'off',
    background: [0.027, 0.035, 0.05, 1],
  });
  const monitor = createMonitor(gpu, {
    canvas: element<HTMLCanvasElement>('monitor'),
    source: history.data,
    at: body.time,
    traces: {
      height: { from: 'Body', y: 'height', color: [0.4, 0.78, 1, 1], widthPx: 2 },
      speed: { from: 'Body', y: 'speed', color: [1, 0.56, 0.32, 1], widthPx: 2 },
      volume: { from: 'Body', y: 'volume', color: [0.8, 0.62, 1, 1], widthPx: 2 },
    },
    camera: { x: [0, WINDOW], fit: true },
    xAxis: 'Time (s)',
    yAxis: 'm · m/s · volume',
    cursorColor: [1, 0.9, 0.83, 1],
    background: [0.027, 0.035, 0.05, 1],
  });
  for (const view of [network, monitor]) view.on('error', fail);
  element('dataset').textContent =
    `Stanford bunny | ${mesh.count.toLocaleString()} vertices | ${(mesh.edges.length / 2).toLocaleString()} springs | ${(mesh.triangles.length / 3).toLocaleString()} faces`;

  // Live simulation, a slow instant replay, or a scrubbed moment.
  let live = true,
    timeScale = 1,
    carry = 0,
    previous = performance.now(),
    animation = 0,
    lastReadout = 0,
    simulationMs = 0,
    replay: { at: number; end: number } | undefined;
  const frames: number[] = [];

  // Where the network draws a point: the tilt projection, with z in meters.
  let drawn: Camera = network.camera;
  network.on('camera', (camera) => (drawn = camera));
  const viewport = () => [canvas.clientWidth, canvas.clientHeight] as const;
  function project(x: number, y: number, z: number) {
    const [width, height] = viewport(),
      b = (drawn.bearing * Math.PI) / 180,
      p = (drawn.pitch * Math.PI) / 180;
    const dx = x - drawn.center[0],
      dy = y - drawn.center[1];
    const rx = dx * Math.cos(b) + dy * Math.sin(b),
      ry = -dx * Math.sin(b) + dy * Math.cos(b);
    const distance = (height * 1.5) / drawn.scale,
      w = distance + ry * Math.sin(p) - z * Math.cos(p),
      k = (drawn.scale * distance) / w;
    return { x: width / 2 + rx * k, y: height / 2 - (ry * Math.cos(p) + z * Math.sin(p)) * k, w };
  }
  /** The point drawn at a canvas point, at depth w. */
  function unproject(sx: number, sy: number, w: number): [number, number, number] {
    const [width, height] = viewport(),
      b = (drawn.bearing * Math.PI) / 180,
      p = (drawn.pitch * Math.PI) / 180;
    const distance = (height * 1.5) / drawn.scale,
      k = w / (drawn.scale * distance);
    const rx = (sx - width / 2) * k,
      up = (height / 2 - sy) * k,
      q = w - distance;
    const ry = up * Math.cos(p) + q * Math.sin(p),
      z = up * Math.sin(p) - q * Math.cos(p);
    return [
      drawn.center[0] + rx * Math.cos(b) - ry * Math.sin(b),
      drawn.center[1] + rx * Math.sin(b) + ry * Math.cos(b),
      z,
    ];
  }
  const local = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return [
      event.clientX - rect.left - canvas.clientLeft,
      event.clientY - rect.top - canvas.clientTop,
    ] as const;
  };
  /** The nearest vertex in front under a canvas point. */
  function under(sx: number, sy: number) {
    let best: { row: number; w: number } | undefined,
      score = Infinity;
    for (let i = 0; i < mesh.count; i++) {
      const s = project(body.x[i * 3]!, body.x[i * 3 + 1]!, body.x[i * 3 + 2]!);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d > 14) continue;
      // Prefer what is in front: each meter nearer counts as a tenth of a meter drawn.
      const rank = d + s.w * drawn.scale * 0.1;
      if (rank < score) {
        score = rank;
        best = { row: i, w: s.w };
      }
    }
    return best;
  }
  let held:
    | { id: number; row: number; w: number; from: readonly [number, number]; moved: boolean }
    | undefined;
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || event.shiftKey || !live) return;
      const point = local(event),
        hit = under(point[0], point[1]);
      if (!hit) return;
      // Ours, not the view's: it neither pans nor selects.
      event.stopImmediatePropagation();
      canvas.setPointerCapture(event.pointerId);
      held = { id: event.pointerId, row: hit.row, w: hit.w, from: point, moved: false };
      body.grab(hit.row, unproject(point[0], point[1], hit.w));
      canvas.classList.add('holding');
    },
    { capture: true },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerId !== held?.id) {
        if (!held && live) canvas.classList.toggle('grabbable', !!under(...local(event)));
        return;
      }
      event.stopImmediatePropagation();
      const point = local(event);
      held.moved ||= Math.hypot(point[0] - held.from[0], point[1] - held.from[1]) > 4;
      body.drag(unproject(point[0], point[1], held.w));
    },
    { capture: true },
  );
  const letGo = (event: PointerEvent) => {
    if (event.pointerId !== held?.id) return;
    event.stopImmediatePropagation();
    body.release();
    if (!held.moved) body.poke(held.row);
    held = undefined;
    canvas.classList.remove('holding');
  };
  canvas.addEventListener('pointerup', letGo, { capture: true });
  canvas.addEventListener('pointercancel', letGo, { capture: true });

  network.on('frame', (_: FrameInfo) => frames.push(performance.now()));
  function show(at: number) {
    const start = history.start,
      end = history.end;
    const x0 = Math.max(start, at - WINDOW * 0.8);
    network.set({ source: history.data, at });
    monitor.set({ source: history.data, at, camera: { x: [x0, x0 + WINDOW] } });
    slider.min = String(start);
    slider.max = String(Math.max(end, start + 1e-3));
    slider.value = String(at);
    element<HTMLOutputElement>('time-value').value = at.toFixed(2) + ' s';
  }
  function tick(now: number) {
    const elapsed = Math.min(0.1, (now - previous) / 1000);
    previous = now;
    if (replay) {
      replay.at += elapsed * 0.3;
      if (replay.at >= replay.end) setLive(true);
      else show(replay.at);
    } else if (live) {
      const begin = performance.now();
      carry += elapsed * timeScale;
      const steps = body.advance(carry, controls);
      carry -= steps * STEP;
      if (steps) {
        publish();
        show(body.time);
      }
      simulationMs += (performance.now() - begin - simulationMs) * 0.1;
    }
    if (now - lastReadout > 250) readouts(now);
    animation = requestAnimationFrame(tick);
  }
  function readouts(now: number) {
    lastReadout = now;
    while (frames.length && frames[0]! < now - 1000) frames.shift();
    const stats = network.stats();
    const [height, speed, volume] = body.metrics();
    element('network-metrics').textContent =
      `${frames.length} FPS | simulate ${simulationMs.toFixed(1)} ms | prepare ${stats.prepareMs.toFixed(1)} ms | center ${height.toFixed(2)} m | ${speed.toFixed(1)} m/s | volume ${(volume * 100).toFixed(0)}%`;
    status.textContent = replay
      ? `Instant replay at 0.3× | ${replay.at.toFixed(2)} s`
      : live
        ? `Live | ${history.end.toFixed(1)} s simulated, ${(history.end - history.start).toFixed(1)} s kept`
        : `Paused at ${Number(slider.value).toFixed(2)} s | drag the timeline, or resume`;
  }
  const liveButton = element<HTMLButtonElement>('live');
  function setLive(value: boolean) {
    live = value;
    replay = undefined;
    carry = 0;
    liveButton.textContent = live ? 'Pause' : 'Resume';
    if (live) show(body.time);
    if (!live) {
      body.release();
      held = undefined;
      canvas.classList.remove('grabbable', 'holding');
    }
  }
  liveButton.addEventListener('click', () => setLive(!live));
  element('replay').addEventListener('click', () => {
    setLive(false);
    replay = { at: Math.max(history.start, history.end - 3), end: history.end };
  });
  slider.addEventListener('input', () => {
    setLive(false);
    show(Number(slider.value));
  });

  // Actions: buttons and keys.
  const act = (name: string) => {
    if (!live) setLive(true);
    if (name === 'jump') body.jump();
    else if (name === 'squash') body.squash();
    else if (name === 'explode') body.explode();
    else if (name === 'drop') body.drop();
    else if (name === 'poke') body.poke(Math.floor(Math.random() * mesh.count), 9);
  };
  const toggles = {
    wind: (on: boolean) => (controls.wind = on),
    orbit: (on: boolean) => network.set({ camera: { orbit: on } }),
  };
  const toggle = (name: keyof typeof toggles) => {
    const button = element<HTMLButtonElement>(name);
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    toggles[name](on);
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]'))
    button.addEventListener('click', () => act(button.dataset.action!));
  for (const name of Object.keys(toggles) as (keyof typeof toggles)[])
    element(name).addEventListener('click', () => toggle(name));
  const KEYS: Record<string, string> = {
    ' ': 'jump',
    s: 'squash',
    e: 'explode',
    d: 'drop',
    p: 'poke',
  };
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
      return;
    const key = event.key.toLowerCase();
    const action = KEYS[key];
    if (action) {
      event.preventDefault();
      act(action);
    } else if (key === 'w') toggle('wind');
    else if (key === 'o') toggle('orbit');
    else if (key === 'r') element('replay').click();
  });

  // Settings.
  const range = (id: string, apply: (value: number) => string) => {
    const input = element<HTMLInputElement>(id),
      output = element<HTMLOutputElement>(id + '-value');
    const update = () => (output.value = apply(Number(input.value)));
    input.addEventListener('input', update);
    update();
  };
  range('firmness', (value) => {
    controls.firmness = value;
    return value < 0.2 ? 'Jelly' : value < 0.6 ? 'Gummy' : 'Rubber';
  });
  range('inflate', (value) => {
    controls.inflate = value;
    return `${Math.round(value * 100)}%`;
  });
  const gravity = element<HTMLSelectElement>('gravity');
  gravity.addEventListener('change', () => (controls.gravity = Number(gravity.value)));
  const speed = element<HTMLSelectElement>('speed');
  speed.addEventListener('change', () => (timeScale = Number(speed.value)));
  const paint = element<HTMLSelectElement>('paint');
  const legend = () => {
    const chosen = PAINTS[paint.value as Paint];
    element('palette').style.background = colormapCss(colormaps[chosen.colormap], {
      direction: 'to right',
    });
    element('palette-label').textContent = chosen.unit;
  };
  paint.addEventListener('change', () => {
    network.set({ vertices: { Vertex: { color: color(paint.value as Paint) } } });
    legend();
  });
  legend();

  stop = () => cancelAnimationFrame(animation);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setLive(false);
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    stop();
    network.destroy();
    monitor.destroy();
    gpu.destroy();
  });
  for (const control of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >('button, input, select'))
    control.disabled = false;
  show(body.time);
  animation = requestAnimationFrame(tick);
}
void main().catch(fail);
