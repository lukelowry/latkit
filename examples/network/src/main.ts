import {
  COLORMAP_LABEL,
  colormap,
  colormapGradientCss,
  type ColormapName,
} from '@latkit/colormaps';
import { requestDevice } from '@latkit/gpu';
import { createNetwork, type Network } from '@latkit/network';
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
  wireProjections(net);
  wireToggles(net, (on) => {
    heightOn = on;
    applyChannels();
  });
  wireColormaps(net);
  wirePicking(net);

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
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

function wireProjections(net: Network): void {
  const modes = ['flat', 'tilt', 'globe'] as const;
  const row = document.getElementById('projections') as HTMLElement;

  for (const mode of modes) {
    const btn = createButton(mode, mode === 'flat');
    btn.disabled = !net.projections[mode];
    btn.addEventListener('click', () => {
      if (!net.setProjection(mode)) return;
      setActive(row, btn);
    });
    row.appendChild(btn);
  }
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
