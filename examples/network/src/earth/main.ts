/**
 * A grid over the earth. Choose a synthetic grid, or a lattice past them in size, and the map
 * beneath it; color the buses by voltage, load, or generation, and the states by
 * the grid's figures; play a simulated fault and watch the machines' speeds swing. Pan, zoom, turn
 * the globe, and hover or click anything to inspect it.
 */
import { colormaps, createGpu, type Colormap, type RGBA, type ProjectedCamera } from '@latkit/gpu';
import { createNetwork, type Network } from '@latkit/network';
import { createGeography, type Geography } from '@latkit/geography';
import {
  BUS_COLORS,
  GRIDS,
  SPEED,
  VOLTAGE_LEGEND,
  gridOptions,
  type BusColor,
  type Grid,
} from './grids.js';
import { MAPS, type MapLoaded } from './maps.js';
import { STATE_FIELDS, stateValues, type StateField, type StateValues } from './states.js';
import { Inspector } from './inspector.js';
import {
  button,
  choose,
  element,
  field,
  legend,
  rechoose,
  section,
  segmented,
  slider,
  stats,
  toggle,
} from './controls.js';
import './style.css';

const THEME = {
  background: [0.02, 0.028, 0.04, 1] as RGBA,
  ground: [0.055, 0.075, 0.105, 1] as RGBA,
  fill: [0.1, 0.13, 0.17, 1] as RGBA,
  line: [0.42, 0.5, 0.58, 0.55] as RGBA,
  coast: [0.55, 0.64, 0.72, 0.85] as RGBA,
};
/** Noon over the western US at midsummer, where the first grid lies. */
const NOON = Date.UTC(2026, 5, 21, 19);
const STATE_COLORMAPS: Readonly<Record<StateField, Colormap>> = {
  buses: colormaps.viridis,
  load: colormaps.mako,
  generation: colormaps.amber,
  swing: colormaps.inferno,
};
const RATES = [0.1, 0.25, 1] as const;
const fixed = (value: number) => (value >= 100 ? value.toFixed(0) : value.toPrecision(2));

const statusEl = document.getElementById('status')!,
  panel = document.getElementById('sections')!,
  attribution = document.getElementById('attribution')!,
  stage = document.getElementById('stage') as HTMLCanvasElement;
function status(message: string, error = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
  if (error) statusEl.setAttribute('role', 'alert');
  else statusEl.removeAttribute('role');
}
function fail(error: unknown): void {
  if ((error as { name?: string }).name === 'AbortError') return;
  status(error instanceof Error ? error.message : String(error), true);
  console.error(error);
}

async function main(): Promise<void> {
  // The million-bus lattice holds about 400 MB on the GPU, past the default budget.
  const gpu = await createGpu({ budget: { gpuBytes: 1024 ** 3 } });
  const state = {
    grid: GRIDS[0]!,
    loaded: undefined as Grid | undefined,
    map: MAPS[0]!,
    drawn: undefined as MapLoaded | undefined,
    /** What the states color by, and the grid's figures for them. */
    areas: 'none' as 'none' | StateField,
    values: undefined as StateValues | undefined,
    color: 'level' as BusColor,
    machines: true,
    labels: false,
    mapLabels: true,
    graticule: false,
    atmosphere: true,
    daylight: 'noon' as 'off' | 'now' | 'noon',
    at: 0,
    playing: false,
    rate: 0.25 as (typeof RATES)[number],
  };

  /** What the map draws: the chosen map, its states colored as chosen. */
  function mapConfig(): Geography.Config {
    const base: Geography.Config = {
      surfaceColor: THEME.ground,
      areaColor: THEME.fill,
      lineColor: THEME.line,
      // Rivers' comets glint in the water's own color, far apart, beneath the grid's.
      flowColor: [0.5, 0.72, 1, 0.5],
      flowSpacingPx: 96,
      grid: state.graticule,
      atmosphere: state.atmosphere,
      daylight: state.daylight === 'off' ? false : state.daylight === 'now' ? 'now' : NOON,
    };
    const drawn = state.drawn;
    if (!drawn) return base;
    const areas = { ...drawn.config.areas };
    if (drawn.states) {
      const type = drawn.states.type,
        values = state.areas !== 'none' ? state.values : undefined;
      areas[type] = {
        ...areas[type],
        labels: state.mapLabels ? areas[type]?.labels : null,
        ...(values && state.areas !== 'none'
          ? {
              values: values.data,
              color: {
                field: state.areas,
                domain: [0, Math.max(1e-6, values.peaks[state.areas])],
                colormap: STATE_COLORMAPS[state.areas],
                missing: THEME.fill,
              },
            }
          : {}),
      };
    }
    return { ...base, ...drawn.config, areas };
  }
  const earth = createGeography(gpu, mapConfig());

  /** What the network draws for the loaded grid, as the panel says. */
  function gridConfig(grid: Grid): Network.Config {
    return {
      canvas: stage,
      source: grid.data,
      ground: earth,
      ...gridOptions(grid, { color: state.color, machines: state.machines, labels: state.labels }),
      fitPaddingPx: [48, 48, 48, window.innerWidth > 720 ? 340 : 48],
      background: THEME.background,
    };
  }
  const controller = new AbortController();
  status(`${state.grid.label}: loading…`);
  state.loaded = await state.grid.load(controller.signal, (m) =>
    status(`${state.grid.label}: ${m}`),
  );
  const network = createNetwork(gpu, {
    ...gridConfig(state.loaded),
    camera: { projection: 'globe', fit: true },
    // Simulated grids are sampled over seconds; the map's states read their swing at the same time.
    at: 0,
  });
  network.on('error', fail);
  earth.on('error', fail);
  const restyleGrid = () => {
    if (state.loaded) network.set(gridConfig(state.loaded), { animate: true });
  };
  const restyleMap = () => earth.set(mapConfig(), { replace: true });

  // The grid's figures for each state, once per grid and map.
  const joined = new WeakMap<object, WeakMap<object, Promise<StateValues>>>();
  async function joinStates(): Promise<void> {
    const grid = state.loaded?.case,
      states = state.drawn?.states;
    state.values = undefined;
    showAreaLegend();
    if (state.areas === 'none' || !grid || !states) return restyleMap();
    let byMap = joined.get(grid);
    if (!byMap) joined.set(grid, (byMap = new WeakMap()));
    let values = byMap.get(states.data);
    if (!values) byMap.set(states.data, (values = stateValues(states.data, states.type, grid)));
    const found = await values;
    if (state.loaded?.case !== grid || state.drawn?.states !== states) return;
    state.values = found;
    restyleMap();
    showAreaLegend();
    stateSummary.textContent = `the grid reaches ${found.states} states`;
  }

  // ── Grid ──
  const gridSection = section(panel, 'Grid');
  field(
    gridSection,
    'source',
    choose(
      GRIDS.map((g) => ({ value: g.id, label: g.label, group: g.group })),
      state.grid.id,
      (value) => void loadGrid(GRIDS.find((g) => g.id === value)!).catch(fail),
      'grid',
    ),
  );
  const colorSelect = choose(
    (Object.keys(BUS_COLORS) as BusColor[]).map((value) => ({
      value,
      label: BUS_COLORS[value].label,
    })),
    state.color,
    (value) => {
      state.color = value as BusColor;
      restyleGrid();
      showGridLegend();
    },
    'color buses by',
  );
  const colorRow = field(gridSection, 'color by', colorSelect),
    gridLegend = legend(gridSection),
    gridSummary = element('p', { className: 'summary' });
  gridSection.append(gridSummary);
  function showGridLegend(): void {
    const grid = state.loaded;
    colorRow.hidden = !grid?.case;
    if (!grid?.buses) return gridLegend(null);
    if (!grid.case) return gridLegend({ colormap: colormaps.viridis, from: 'center', to: 'edge' });
    if (state.color === 'level') return gridLegend(VOLTAGE_LEGEND);
    gridLegend({
      colormap: BUS_COLORS[state.color].colormap,
      from: '0',
      to: `${fixed(grid.peaks[state.color])} MW`,
    });
  }

  // ── Simulation ──
  const simulationSection = section(panel, 'Simulation');
  const play = button('play', () => setPlaying(!state.playing)),
    time = slider('time', [0, 1], (value) => {
      setPlaying(false);
      seek(value);
    }),
    clock = element('output', { className: 'clock' });
  field(simulationSection, 'time', play, clock, time);
  field(
    simulationSection,
    'rate',
    segmented(
      RATES.map((rate) => ({ value: String(rate), label: `${rate}×` })),
      String(state.rate),
      (value) => (state.rate = Number(value) as (typeof RATES)[number]),
      'playback rate',
    ).root,
  );
  const speedLegend = legend(simulationSection),
    simulationSummary = element('p', { className: 'summary' });
  simulationSection.append(simulationSummary);
  let last = 0,
    inspected = 0;
  function seek(at: number): void {
    state.at = at;
    network.set({ at });
    time.value = String(at);
    clock.textContent = `${at.toFixed(2)} s`;
    const fault = state.loaded?.case?.simulation?.fault;
    clock.classList.toggle('fault', !!fault && at >= fault.on && at < fault.off);
    inspector.at = at;
    // The inspector reads its row again a few times a second, not every frame.
    if (performance.now() - inspected > 150) {
      inspected = performance.now();
      inspector.refresh();
    }
  }
  function tick(now: number): void {
    const simulation = state.loaded?.case?.simulation;
    if (!state.playing || !simulation) return;
    const next = state.at + ((now - last) / 1000) * state.rate;
    last = now;
    seek(next > simulation.duration ? 0 : next);
    requestAnimationFrame(tick);
  }
  function setPlaying(playing: boolean): void {
    state.playing = playing && !!state.loaded?.case?.simulation;
    play.textContent = state.playing ? 'pause' : 'play';
    play.classList.toggle('on', state.playing);
    if (state.playing) {
      last = performance.now();
      requestAnimationFrame(tick);
    }
  }
  function showSimulation(): void {
    const simulation = state.loaded?.case?.simulation;
    simulationSection.parentElement!.hidden = !simulation;
    setPlaying(false);
    seek(0);
    if (!simulation) return;
    time.max = String(simulation.duration);
    speedLegend({
      colormap: SPEED,
      from: `−${fixed(simulation.largest)}`,
      to: `+${fixed(simulation.largest)} mHz`,
    });
    simulationSummary.textContent =
      `${simulation.frames} frames over ${simulation.duration.toFixed(0)} s · machine speed deviation` +
      (simulation.fault
        ? ` · fault at ${simulation.fault.bus}, ${simulation.fault.on.toFixed(2)}–${simulation.fault.off.toFixed(2)} s`
        : '');
  }

  // ── Map ──
  const mapSection = section(panel, 'Map');
  field(
    mapSection,
    'source',
    choose(
      [
        { value: 'none', label: 'None' },
        ...MAPS.map((m) => ({ value: m.id, label: m.label, group: m.group })),
      ],
      state.map.id,
      (value) => void loadMap(value).catch(fail),
      'map',
    ),
  );
  const areaSelect = choose(
    [],
    'none',
    (value) => {
      state.areas = value as typeof state.areas;
      void joinStates().catch(fail);
    },
    'color states by',
  );
  const areaRow = field(mapSection, 'states by', areaSelect),
    areaLegend = legend(mapSection),
    mapSummary = element('p', { className: 'summary' }),
    stateSummary = element('p', { className: 'summary' });
  mapSection.append(mapSummary, stateSummary);
  /** What the states can color by: the loaded grid's figures, where the map has states. */
  function refreshAreas(): void {
    const grid = state.loaded?.case,
      choices = [
        { value: 'none', label: 'nothing' },
        ...(Object.keys(STATE_FIELDS) as StateField[])
          .filter((name) => name !== 'swing' || grid?.simulation)
          .map((value) => ({ value, label: STATE_FIELDS[value].label })),
      ];
    areaRow.hidden = !grid || !state.drawn?.states;
    rechoose(areaSelect, choices, areaRow.hidden ? 'none' : state.areas);
    state.areas = areaSelect.value as typeof state.areas;
    stateSummary.textContent = '';
    showAreaLegend();
  }
  function showAreaLegend(): void {
    const field = state.areas;
    if (field === 'none' || areaRow.hidden || !state.values) return areaLegend(null);
    areaLegend({
      colormap: STATE_COLORMAPS[field],
      from: '0',
      to: `${fixed(state.values.peaks[field])}${STATE_FIELDS[field].unit}`,
    });
  }

  // Each map stays loaded once chosen, so choosing it again costs nothing.
  const maps = new Map<string, Promise<MapLoaded>>();
  let mapLoad: AbortController | undefined;
  async function loadMap(id: string): Promise<void> {
    mapLoad?.abort();
    const choice = MAPS.find((m) => m.id === id);
    if (!choice) {
      state.drawn = undefined;
      mapSummary.textContent = '';
      refreshAreas();
      restyleMap();
      return credit();
    }
    state.map = choice;
    const load = (mapLoad = new AbortController());
    let promise = maps.get(id);
    if (!promise) {
      promise = choice.load(load.signal, (m) => status(`${choice.label}: ${m}`), THEME);
      maps.set(id, promise);
      promise.catch(() => maps.delete(id));
    }
    const drawn = await promise;
    if (load.signal.aborted) return;
    state.drawn = drawn;
    mapSummary.textContent = drawn.summary;
    refreshAreas();
    await joinStates();
    status(`${choice.label} · ${drawn.summary}`);
    credit();
  }
  let gridLoad: AbortController | undefined;
  async function loadGrid(choice: (typeof GRIDS)[number]): Promise<void> {
    gridLoad?.abort();
    const load = (gridLoad = new AbortController());
    state.grid = choice;
    status(`${choice.label}: loading…`);
    const grid = await choice.load(load.signal, (m) => status(`${choice.label}: ${m}`));
    if (load.signal.aborted) return;
    state.loaded = grid;
    inspector.clear();
    showSimulation();
    network.set(
      { ...gridConfig(grid), at: 0, ...(grid.buses ? { camera: { fit: true } } : {}) },
      { replace: true, animate: true },
    );
    showGrid();
    refreshAreas();
    await joinStates();
    status(`${choice.label} · ${grid.summary}`);
  }
  function showGrid(): void {
    const grid = state.loaded!;
    gridSummary.textContent = grid.buses
      ? `${grid.buses.toLocaleString()} buses · ${grid.lines.toLocaleString()} lines` +
        (grid.case ? ` · ${grid.case.machines.toLocaleString()} machines` : '') +
        ` · ${grid.summary}`
      : '';
    showGridLegend();
  }
  function credit(): void {
    attribution.textContent = state.drawn ? state.map.attribution : '';
  }

  // ── View ──
  const view = section(panel, 'View');
  const PROJECTIONS: readonly ProjectedCamera.Projection[] = ['flat', 'mercator', 'tilt', 'globe'];
  const projection = segmented(
    PROJECTIONS.map((value) => ({ value, label: value })),
    network.camera.projection,
    (value) =>
      network.set(
        { camera: { projection: value as ProjectedCamera.Projection } },
        { animate: true },
      ),
    'projection',
  );
  field(view, 'projection', projection.root);
  const refreshProjections = () => {
    for (const value of PROJECTIONS) projection.enable(value, network.projections[value]);
    projection.set(network.camera.projection);
  };
  network.on('camera', refreshProjections);
  field(
    view,
    'camera',
    button('fit', () => network.fit(undefined, { animate: true })),
    toggle('turn', false, (on) => network.set({ camera: { orbit: on } })),
  );
  field(
    view,
    'daylight',
    segmented(
      (['off', 'now', 'noon'] as const).map((value) => ({ value, label: value })),
      state.daylight,
      (value) => {
        state.daylight = value as typeof state.daylight;
        restyleMap();
      },
      'daylight',
    ).root,
  );

  // ── Layers ──
  const layers = section(panel, 'Layers');
  field(
    layers,
    'grid',
    toggle('buses', true, (on) => network.set({ markers: on })),
    toggle('lines', true, (on) => network.set({ lines: on })),
    toggle('machines', state.machines, (on) => void ((state.machines = on), restyleGrid())),
    toggle('labels', state.labels, (on) => void ((state.labels = on), restyleGrid())),
  );
  field(
    layers,
    'map',
    toggle('labels', state.mapLabels, (on) => void ((state.mapLabels = on), restyleMap())),
    toggle('graticule', state.graticule, (on) => void ((state.graticule = on), restyleMap())),
    toggle('atmosphere', state.atmosphere, (on) => void ((state.atmosphere = on), restyleMap())),
  );

  // ── Performance ──
  const show = stats(section(panel, 'Performance', false), [
    'fps',
    'grid prepare',
    'map prepare',
    'draw calls',
    'grid GPU',
    'map tiles',
    'map drawn',
    'map GPU',
  ]);
  // Frames draw only as the scene changes, so the rate counts those; the rest read twice a second.
  let frames = 0,
    since = performance.now();
  network.on('frame', (frame) => {
    if (frame.presented) frames++;
  });
  setInterval(() => {
    const now = performance.now(),
      g = network.stats(),
      m = earth.stats();
    show({
      fps: frames ? ((frames * 1000) / (now - since)).toFixed(0) : 'idle',
      'grid prepare': `${g.prepareMs.toFixed(1)} ms`,
      'map prepare': `${m.prepareMs.toFixed(1)} ms`,
      'draw calls': `${g.drawCalls} + ${m.drawCalls}`,
      'grid GPU': `${(g.geometryBytes / 1e6).toFixed(1)} MB`,
      'map tiles': m.loading ? `${m.tiles} (+${m.loading} loading)` : String(m.tiles),
      'map drawn': `${(m.triangles / 1000).toFixed(0)}k tri · ${(m.vertices / 1000).toFixed(0)}k vert`,
      'map GPU': `${(m.geometryBytes / 1e6).toFixed(1)} MB`,
    });
    frames = 0;
    since = now;
  }, 500);

  // ── Inspector ──
  const inspector = new Inspector(gpu, document.getElementById('inspector')!, fail);
  network.on('hover', (item) => inspector.hover(item));
  earth.on('hover', (item) => inspector.hover(item));
  network.on('select', (items) => {
    if (items.length) earth.select([]);
    inspector.select(items);
  });
  earth.on('select', (items) => {
    if (items.length) network.select([]);
    inspector.select(items);
  });

  showGrid();
  showSimulation();
  refreshProjections();
  await loadMap(state.map.id).catch(fail);
  status(`${state.grid.label} · ${state.loaded.summary}`);
  Object.assign(window, {
    example: { gpu, network, earth, state, loadMap, loadGrid, seek, setPlaying },
  });
  const dispose = () => {
    controller.abort();
    gridLoad?.abort();
    mapLoad?.abort();
    setPlaying(false);
    network.destroy();
    earth.destroy();
    gpu.destroy();
  };
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) dispose();
  });
  import.meta.hot?.dispose(dispose);
}

void main().catch(fail);
