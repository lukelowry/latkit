import {
  createGpu,
  createCanvasView,
  colormaps,
  colormapCss,
  reverseColormap,
  type Colormap,
  type ColormapName,
} from '@latkit/gpu';
import { ExampleSource, vector } from './source.js';
import {
  createNetwork,
  attachNetworkInput,
  PROJECTIONS,
  type Network,
  type NetworkData,
  type NetworkItem,
  type Projection,
  type VertexOptions,
} from '@latkit/network';
import { TOPOLOGIES, type TopologyOption } from './topologies.js';
import './style.css';

const stage = document.getElementById('stage') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;
const readoutEl = document.getElementById('readout') as HTMLElement;

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  statusEl.textContent = message;
  statusEl.setAttribute('role', 'alert');
  console.error(error);
}

async function loadBorders(signal: AbortSignal): Promise<ExampleSource> {
  const urls = [
    new URL('../../../packages/network/tests/assets/borders.points.bin', import.meta.url),
    new URL('../../../packages/network/tests/assets/borders.offsets.bin', import.meta.url),
  ];
  const [points, offsets] = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error('Could not load native border data');
      return response.arrayBuffer();
    }),
  );
  const starts = new Int32Array(offsets!);
  return new ExampleSource({
    border: {
      count: starts.length - 1,
      columns: {
        points: {
          kind: 'list',
          offset: 0,
          length: starts.length - 1,
          offsets: starts,
          values: vector(new Float32Array(points!)),
        },
      },
    },
  });
}

async function main(): Promise<void> {
  const lifetime = new AbortController();
  let currentId = TOPOLOGIES[0]!.id;
  let current = TOPOLOGIES[0]!.build();
  let heightOn = false,
    geodesic = true,
    bordersOn = false;
  let colors = colormaps.viridis;
  let borders: ExampleSource | undefined;
  const fields = (): VertexOptions => ({
    position: 'position',
    color: { field: 'load', domain: [0, 1], colormap: colors },
    size: current.tables.Bus!.columns.degree
      ? { field: 'degree', domain: [0, 1], range: [0.6, 2] }
      : null,
    height: heightOn ? { field: 'load', domain: [0, 1], range: [0, 0.18] } : null,
  });
  const data = (): NetworkData => ({
    source: current,
    vertices: { Bus: fields() },
    edges: {
      Line: {
        ends: ['from', 'to'],
        ...(current.tables.Line!.columns.bends ? { bends: 'bends' } : {}),
        curve: geodesic ? 'geodesic' : 'linear',
      },
    },
    paths:
      bordersOn && borders
        ? {
            border: {
              source: borders,
              points: 'points',
              widthPx: 0.8,
              baseColor: [0.4, 0.55, 0.65, 0.7],
            },
          }
        : {},
  });
  const gpu = await createGpu();
  const net = createNetwork({
    gpu,
    data: data(),
    options: {
      msaa: 4,
      daylight: true,
      graticule: false,
      hover: 'auto',
      poles: false,
      fitPaddingPx: [48, 48, 48, window.innerWidth > 640 ? 320 : 48],
      vertexBaseColor: [0.36, 0.4, 0.46, 1],
    },
  });
  const view = createCanvasView({
    gpu,
    canvas: stage,
    renderer: net,
    onError: fail,
    onLost: (info) => fail(new Error('GPU unavailable: ' + info.message)),
    onRendered: () => {
      const stats = net.stats();
      statusEl.textContent = `${stats.vertices.toLocaleString()} vertices / ${stats.edges.toLocaleString()} edges`;
      document.getElementById('metrics')!.textContent =
        `${stats.prepareMs.toFixed(1)} ms prepare / ${stats.drawCalls} draws / hover ${stats.hover}`;
      projections.refresh();
    },
  });
  const detach = attachNetworkInput({ network: net, canvas: stage });
  const projections = wireProjections(net);
  wireOrbit(net);
  const fitButton = createButton('fit', false);
  fitButton.onclick = () => net.fit({ animate: true });
  document.getElementById('camera')!.append(fitButton);
  wireTopologies(
    () => currentId,
    (opt) => {
      const previous = current;
      current = opt.build();
      currentId = opt.id;
      net.setOptions({
        vertexRadiusPx: current.tables.Bus!.count >= 100000 ? 1.4 : 4,
        edgeWidthPx: current.tables.Bus!.count >= 100000 ? 0.5 : 1.4,
      });
      net.setData(data());
      net.setCamera({ fit: true });
      void previous.close();
      readoutEl.querySelector('.hover')!.textContent = '-';
      readoutEl.querySelector('.select')!.textContent = '-';
    },
  );
  wireToggles(
    net,
    (on) => {
      heightOn = on;
      net.setVertex('Bus', fields());
    },
    [
      {
        label: 'geodesics',
        on: true,
        apply: (on) => {
          geodesic = on;
          net.setEdge('Line', { curve: on ? 'geodesic' : 'linear' });
        },
      },
      {
        label: 'borders',
        on: false,
        apply: async (on) => {
          if (on && !borders) borders = await loadBorders(lifetime.signal);
          lifetime.signal.throwIfAborted();
          bordersOn = on;
          net.setData(data());
        },
      },
      { label: 'surface poles', on: false, apply: (on) => net.setOptions({ poles: on }) },
    ],
  );
  wireColormaps((value) => {
    colors = value;
    net.setVertex('Bus', fields());
  });
  wirePicking(net);
  Object.assign(window, {
    network: net,
    networkExample: {
      gpu,
      view,
      get source() {
        return current;
      },
    },
  });
  view.request();
  const dispose = (): void => {
    lifetime.abort();
    detach();
    view.destroy();
    net.destroy();
    void current.close();
    void borders?.close();
    gpu.destroy();
  };
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) dispose();
  });
  import.meta.hot?.dispose(dispose);
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

  for (const mode of Object.keys(PROJECTIONS) as Projection[]) {
    const btn = createButton(PROJECTIONS[mode].label, mode === net.projection);
    btn.disabled = !net.projections[mode];
    btn.addEventListener('click', () => {
      if (net.setCamera({ projection: mode })) refresh();
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
  // Gestures and keys on the canvas stop the orbit inside the renderer; the event keeps the
  // button honest, and reduced motion refuses to start it at all.
  net.on('orbit', (active) => setPressed(btn, active));
  btn.addEventListener('click', () => {
    net.orbit(!net.orbiting);
  });
  row.appendChild(btn);
}

interface Toggle {
  label: string;
  on: boolean;
  apply: (value: boolean) => void | Promise<void>;
}
function wireToggles(net: Network, setHeight: (on: boolean) => void, extra: Toggle[]): void {
  const specs: Toggle[] = [
    ...extra,
    { label: 'vertices', on: true, apply: (v) => net.setOptions({ vertices: v }) },
    { label: 'edges', on: true, apply: (v) => net.setOptions({ edges: v }) },
    { label: 'graticule', on: false, apply: (v) => net.setOptions({ graticule: v }) },
    { label: 'earth axis', on: true, apply: (v) => net.setOptions({ earthAxis: v }) },
    { label: 'daylight', on: true, apply: (v) => net.setOptions({ daylight: v }) },
    // A pinned sun holds the terminator still; null follows the clock.
    {
      label: 'noon sun',
      on: false,
      apply: (v) => net.setOptions({ sunTime: v ? Date.UTC(2026, 5, 21, 12) : null }),
    },
    { label: 'height', on: false, apply: setHeight },
    // A base edge color replaces the endpoint-color average.
    {
      label: 'muted edges',
      on: false,
      apply: (v) => net.setOptions({ edgeBaseColor: v ? [0.3, 0.32, 0.36, 1] : null }),
    },
  ];
  const row = document.getElementById('toggles') as HTMLElement;

  for (const spec of specs) {
    const btn = createButton(spec.label, spec.on);
    let on = spec.on;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void Promise.resolve()
        .then(() => spec.apply(!on))
        .then(() => {
          on = !on;
          setPressed(btn, on);
        }, fail)
        .finally(() => {
          btn.disabled = false;
        });
    });
    row.appendChild(btn);
  }
}

function wireColormaps(set: (value: Colormap) => void): void {
  const row = document.getElementById('colormaps')!;
  const select = document.createElement('select');
  select.setAttribute('aria-labelledby', 'colormaps-label');
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const [name, map] of Object.entries(colormaps)) {
    // Load is a continuous quantity; categorical palettes remain available in the gallery.
    if (map.kind === 'categorical') continue;
    let group = groups.get(map.kind);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = map.kind;
      groups.set(map.kind, group);
      select.append(group);
    }
    group.append(new Option(map.label ?? name, name));
  }
  select.value = 'viridis';
  const reverse = createButton('reverse', false);
  const swatch = document.createElement('div');
  swatch.className = 'palette-preview';
  let reversed = false;
  const update = (): void => {
    const map = colormaps[select.value as ColormapName];
    const value = reversed ? reverseColormap(map) : map;
    swatch.style.background = colormapCss(value, { direction: 'to right' });
    set(value);
  };
  reverse.onclick = () => {
    reversed = !reversed;
    setPressed(reverse, reversed);
    update();
  };
  select.onchange = update;
  const gallery = document.createElement('a');
  gallery.href = '/colors.html';
  gallery.target = '_blank';
  gallery.rel = 'noopener';
  gallery.textContent = 'compare all palettes';
  row.append(select, reverse, swatch, gallery);
  update();
}

function wirePicking(net: Network): void {
  const describe = (item: NetworkItem | null): string =>
    item === null ? '-' : `${item.index.type} / row ${item.row}`;

  net.on('hover', (item) => {
    readoutEl.querySelector('.hover')!.textContent = describe(item);
  });
  // Pointer taps and Escape both arrive here; the keyboard map is the controller's.
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

void main().catch(fail);
