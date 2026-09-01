import {
  COLORMAP_LABEL,
  colormap,
  colormapGradientCss,
  type ColormapName,
} from '@latkit/colormaps';
import { requestDevice } from '@latkit/gpu';
import { createNetwork, type Network, type ProjectionMode } from '@latkit/network';
import { TOPOLOGIES, type GeneratedTopology, type TopologyOption } from './topologies.js';
import './style.css';

const EXAMPLE_COLORMAPS = [
  'viridis',
  'magma',
  'cividis',
] as const satisfies readonly ColormapName[];

const stage = document.getElementById('stage') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;
const readoutEl = document.getElementById('readout') as HTMLElement;

function fail(message: string): void {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML =
    `<h2>Cannot render</h2><p>${message}</p>` +
    '<p class="hint">This example needs a browser with WebGPU support.</p>';
  stage.replaceWith(box);
}

async function main(): Promise<void> {
  let currentId = TOPOLOGIES[0]!.id;
  let current: GeneratedTopology = TOPOLOGIES[0]!.build();
  let heightOn = false;

  setStatus(current);

  let device: GPUDevice;
  try {
    device = await requestDevice();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  let net: Network;
  try {
    net = await createNetwork(device, stage, {
      msaa: 4,
      daylight: true,
      graticule: false,
      borders: false,
      baseColor: [0.36, 0.4, 0.46, 1],
      colormap: colormap(EXAMPLE_COLORMAPS[0]!),
    });
  } catch (err) {
    device.destroy();
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  function applyChannels(): void {
    net.setChannel('vertexColor', current.color, [0, 1]);

    if (current.size) net.setChannel('vertexSize', current.size, [0, 1]);
    else net.clearChannel('vertexSize');

    if (heightOn) net.setChannel('vertexHeight', current.color, [0, 1], [0, 1]);
    else net.clearChannel('vertexHeight');
  }

  function applyTopology(opt: TopologyOption): void {
    current = opt.build();
    currentId = opt.id;
    setStatus(current);
    net.load(current.topology);
    applyChannels();
  }

  net.load(current.topology);
  applyChannels();
  net.fadeIn();

  wireTopologies(() => currentId, applyTopology);
  const projections = wireProjections(net);
  const cameraDemo = wireCameraDemo(net, projections);
  wireToggles(net, (on) => {
    heightOn = on;
    applyChannels();
  });
  wireColormaps(net);
  wirePicking(net);

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    cameraDemo.destroy();
    net.destroy();
    device.destroy();
  });
}

function setStatus(topology: GeneratedTopology): void {
  statusEl.textContent = `${topology.vertexCount.toLocaleString()} vertices / ${topology.edgeCount.toLocaleString()} edges`;
}

function wireTopologies(currentId: () => string, apply: (opt: TopologyOption) => void): void {
  const row = document.getElementById('topologies') as HTMLElement;

  for (const opt of TOPOLOGIES) {
    const btn = createButton(opt.label, opt.id === currentId());
    btn.addEventListener('click', () => {
      if (opt.id === currentId()) return;
      apply(opt);
      setActive(row, btn);
    });
    row.appendChild(btn);
  }
}

interface ProjectionControls {
  select(mode: ProjectionMode): boolean;
  mode(): ProjectionMode;
}

function wireProjections(net: Network): ProjectionControls {
  const modes: readonly ProjectionMode[] = ['flat', 'tilt', 'globe'];
  const row = document.getElementById('projections') as HTMLElement;
  const buttons = new Map<ProjectionMode, HTMLButtonElement>();
  let active: ProjectionMode = 'flat';

  function select(mode: ProjectionMode): boolean {
    if (!net.setProjection(mode)) return false;
    active = mode;
    setActive(row, buttons.get(mode)!);
    return true;
  }

  for (const mode of modes) {
    const btn = createButton(mode, mode === 'flat');
    btn.disabled = !net.projections[mode];
    btn.addEventListener('click', () => {
      select(mode);
    });
    buttons.set(mode, btn);
    row.appendChild(btn);
  }

  return { select, mode: () => active };
}

/** Longitude drift for the globe spin, in degrees per millisecond (8 deg/s,
 *  the same rate the tilt bearing orbit resolves to). */
const SPIN_DEG_PER_MS = 0.008;

function wireCameraDemo(
  net: Network,
  { select, mode }: ProjectionControls,
): { destroy(): void } {
  const row = document.getElementById('camera') as HTMLElement;
  const projections = document.getElementById('projections') as HTMLElement;
  const btn = createButton('auto rotate', false);
  let frameId: number | null = null;
  let previousTime = 0;

  function stop(): void {
    if (frameId === null) return;
    cancelAnimationFrame(frameId);
    frameId = null;
    previousTime = 0;
    setPressed(btn, false);
  }

  function frame(time: number): void {
    if (frameId === null) return;
    if (previousTime !== 0) {
      const elapsed = Math.min(time - previousTime, 50);
      if (mode() === 'globe') {
        // Spin the globe about its axis: drift the pose longitude and let the
        // camera chase ease it, holding latitude, pitch, and bearing as-is.
        const pose = net.getPose();
        if (pose) {
          net.setPose({ centerX: pose.centerX + elapsed * SPIN_DEG_PER_MS }, { animate: true });
        }
      } else {
        net.rotateBy(elapsed * 0.02, 0);
      }
    }
    previousTime = time;
    frameId = requestAnimationFrame(frame);
  }

  btn.addEventListener('click', () => {
    if (frameId !== null) {
      stop();
      return;
    }
    if (mode() !== 'globe' && !select('tilt')) return;
    setPressed(btn, true);
    frameId = requestAnimationFrame(frame);
  });
  stage.addEventListener('pointerdown', stop);
  stage.addEventListener('wheel', stop, { passive: true });
  projections.addEventListener('click', stop);
  row.appendChild(btn);

  return {
    destroy() {
      stop();
      stage.removeEventListener('pointerdown', stop);
      stage.removeEventListener('wheel', stop);
      projections.removeEventListener('click', stop);
    },
  };
}

function wireToggles(net: Network, setHeight: (on: boolean) => void): void {
  const specs: { label: string; on: boolean; apply: (v: boolean) => void }[] = [
    { label: 'vertices', on: true, apply: (v) => net.setOptions({ vertices: v }) },
    { label: 'edges', on: true, apply: (v) => net.setOptions({ edges: v }) },
    { label: 'graticule', on: false, apply: (v) => net.setOptions({ graticule: v }) },
    { label: 'earth axis', on: true, apply: (v) => net.setOptions({ earthAxis: v }) },
    { label: 'daylight', on: true, apply: (v) => net.setOptions({ daylight: v }) },
    { label: 'height', on: false, apply: setHeight },
  ];
  const row = document.getElementById('toggles') as HTMLElement;

  for (const spec of specs) {
    const btn = createButton(spec.label, spec.on);
    let on = spec.on;
    btn.addEventListener('click', () => {
      on = !on;
      spec.apply(on);
      setPressed(btn, on);
    });
    row.appendChild(btn);
  }
}

function wireColormaps(net: Network): void {
  const row = document.getElementById('colormaps') as HTMLElement;

  for (let i = 0; i < EXAMPLE_COLORMAPS.length; i++) {
    const name = EXAMPLE_COLORMAPS[i]!;
    const fn = colormap(name);
    const btn = createButton(COLORMAP_LABEL[name], i === 0);
    btn.classList.add('swatch');
    btn.style.setProperty('--swatch', colormapGradientCss(name, 'to right'));
    btn.addEventListener('click', () => {
      net.setColormap(fn);
      setActive(row, btn);
    });
    row.appendChild(btn);
  }
}

function wirePicking(net: Network): void {
  const describe = (kind: 'vertex' | 'edge' | null, index: number | null): string =>
    kind === null ? '-' : `${kind} #${index}`;

  net.on('hover', (kind, index) => {
    readoutEl.querySelector('.hover')!.textContent = describe(kind, index);
  });
  net.on('select', (kind, index) => {
    readoutEl.querySelector('.select')!.textContent = describe(kind, index);
  });
}

function createButton(label: string, pressed: boolean): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  setPressed(btn, pressed);
  return btn;
}

function setPressed(btn: HTMLButtonElement, pressed: boolean): void {
  btn.classList.toggle('active', pressed);
  btn.setAttribute('aria-pressed', String(pressed));
}

function setActive(row: HTMLElement, active: HTMLButtonElement): void {
  for (const btn of row.querySelectorAll('button')) {
    setPressed(btn, btn === active);
  }
}

void main();
