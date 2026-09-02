import { COLORMAPS, colormap, gradient, type ColormapName } from '@latkit/colormaps';
import { requestDevice } from '@latkit/gpu';
import {
  createNetwork,
  PROJECTIONS,
  type Item,
  type Network,
  type Projection,
} from '@latkit/network';
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

    net.setChannel('vertexSize', current.size ?? null, [0, 1]);
    net.setChannel('vertexHeight', heightOn ? current.color : null, [0, 1]);
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

  const projections = wireProjections(net);
  wireOrbit(net);
  wireTopologies(
    () => currentId,
    (opt) => {
      applyTopology(opt);
      // Loading can drop projection support and fall back to flat.
      projections.refresh();
    },
  );
  wireToggles(net, (on) => {
    heightOn = on;
    applyChannels();
  });
  wireColormaps(net);
  wirePicking(net);
  wireKeyboard(net);

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

interface ProjectionControls {
  refresh(): void;
}

function wireProjections(net: Network): ProjectionControls {
  const row = document.getElementById('projections') as HTMLElement;
  const buttons = new Map<Projection, HTMLButtonElement>();

  /** Sync pressed and disabled states with the network's live state. */
  function refresh(): void {
    for (const [mode, btn] of buttons) {
      btn.disabled = !net.projections[mode];
      setPressed(btn, mode === net.projection);
    }
  }

  for (const mode of PROJECTIONS) {
    const btn = createButton(mode, mode === net.projection);
    btn.disabled = !net.projections[mode];
    btn.addEventListener('click', () => {
      if (net.setProjection(mode)) refresh();
    });
    buttons.set(mode, btn);
    row.appendChild(btn);
  }
  // Orbit promotes flat to tilt; mirror that in the buttons.
  net.on('orbit', refresh);

  return { refresh };
}

function wireOrbit(net: Network): void {
  const row = document.getElementById('camera') as HTMLElement;
  const btn = createButton('auto rotate', false);
  // Gestures on the canvas stop the orbit inside the renderer; the event keeps the button honest.
  net.on('orbit', (active) => setPressed(btn, active));
  btn.addEventListener('click', () => {
    net.orbit(!net.orbiting);
  });
  stage.addEventListener('keydown', () => net.orbit(false));
  row.appendChild(btn);
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
    const btn = createButton(COLORMAPS[name].label, i === 0);
    btn.classList.add('swatch');
    btn.style.setProperty('--swatch', gradient(name, 'to right'));
    btn.addEventListener('click', () => {
      net.setOptions({ colormap: fn });
      setActive(row, btn);
    });
    row.appendChild(btn);
  }
}

/** Screen pixels one arrow keypress pans or rotates by. */
const KEY_PAN_PX = 48;

function wireKeyboard(net: Network): void {
  stage.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Shift + arrows rotates (bearing/pitch); plain arrows pan the view.
    const move = (dx: number, dy: number): void => {
      if (event.shiftKey) net.rotateBy(dx, dy);
      else net.panBy(-dx, -dy);
    };
    switch (event.key) {
      case 'ArrowLeft':
        move(-KEY_PAN_PX, 0);
        break;
      case 'ArrowRight':
        move(KEY_PAN_PX, 0);
        break;
      case 'ArrowUp':
        move(0, -KEY_PAN_PX);
        break;
      case 'ArrowDown':
        move(0, KEY_PAN_PX);
        break;
      case '+':
      case '=':
        net.zoomBy(1.2);
        break;
      case '-':
      case '_':
        net.zoomBy(1 / 1.2);
        break;
      case 'Escape':
        net.select(null);
        readoutEl.querySelector('.select')!.textContent = '-';
        break;
      default:
        return;
    }
    event.preventDefault();
  });
}

function wirePicking(net: Network): void {
  const describe = (item: Item | null): string =>
    item === null ? '-' : `${item.kind} #${item.index}`;

  net.on('hover', (item) => {
    readoutEl.querySelector('.hover')!.textContent = describe(item);
  });
  net.on('select', (item) => {
    readoutEl.querySelector('.select')!.textContent = describe(item);
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
