/**
 * A grid at scale over the earth. Choose a synthetic grid, from WECC 240-bus to ACTIVSg70k, a
 * continent's grid of two million buses built in the page, or a lattice of up to a million buses,
 * and the map beneath it: coasts and borders, Natural Earth's states colored by the grid's figures,
 * or OpenStreetMap's planet as vector tiles. Play a simulated fault and watch the machines' speeds
 * swing; turn the globe at noon or now; hover or click anything to inspect it.
 */
import {
  field,
  type ColormapName,
  type Fit,
  type Hit,
  type Mark,
  type Row,
  type Scene,
} from '../latkit.js';
import type { Stage } from '../ui/stage.js';
import { LEVELS, loadCase, type Case } from './cases.js';
import { continent } from './continent.js';
import { lattice } from './lattice.js';
import { LOOK, MAPS, type Loaded, type MapChoice } from './maps.js';
import { STATE_FIELDS, joinStates, type Joined, type StateField } from './states.js';

/** The grids the page draws, synthetic cases first. */
const GRIDS = [
  ['WECC 240-bus, simulated fault', 'wecc240'],
  ['ACTIVSg2000, Texas', 'activsg2000'],
  ['ACTIVSg10k, western US, simulated fault', 'activsg10k'],
  ['ACTIVSg25k, US Northeast', 'activsg25k'],
  ['ACTIVSg70k, eastern US', 'activsg70k'],
  ['North America, 2,000,000 buses', 'continent-2m'],
  ['Lattice, 100,000 buses', 'lattice-100k'],
  ['Lattice, 1,000,000 buses', 'lattice-1m'],
] as const;
type GridId = (typeof GRIDS)[number][1];

/** Each voltage level's color, from below 100 kV to 765 kV. */
const LEVEL_COLORS = ['#56657a', '#2fa49b', '#7fc97f', '#e6c84f', '#f08a3c', '#e5486f'];
const BUS_COLORS = {
  level: { label: 'voltage level', colormap: undefined },
  load: { label: 'load', colormap: 'mako' },
  generation: { label: 'generation', colormap: 'amber' },
} as const satisfies Record<string, { label: string; colormap: ColormapName | undefined }>;
type BusColor = keyof typeof BUS_COLORS;
const STATE_COLORMAPS: Readonly<Record<StateField, ColormapName>> = {
  buses: 'viridis',
  load: 'mako',
  generation: 'amber',
  swing: 'inferno',
};
/** Fields the inspector leaves out: where a row is, which the view shows, and translations. */
const HIDDEN = /^(lon|lat|geometry|position|name_.*|name:.*)$/;
/** Noon over the western US at midsummer, where the first grid lies: seconds after the epoch. */
const NOON = Date.UTC(2026, 5, 21, 19) / 1000;
const fixed = (value: number) => (value >= 100 ? value.toFixed(0) : value.toPrecision(2));

/** A grid drawn: its dataset and counts, and the case it came from when it is one. */
interface Grid {
  readonly id: GridId;
  readonly label: string;
  readonly buses: number;
  readonly lines: number;
  readonly summary: string;
  readonly case?: Case;
  readonly peaks: { readonly load: number; readonly generation: number; readonly power: number };
  /** The box its buses stand in, which framing the grid shows. */
  readonly bounds: Fit;
}

/** The box a case's buses stand in. */
function extent(positions: Float32Array): Fit {
  const min: [number, number, number] = [Infinity, Infinity, 0];
  const max: [number, number, number] = [-Infinity, -Infinity, 0];
  for (let i = 0; i < positions.length; i += 2) {
    min[0] = Math.min(min[0], positions[i]!);
    min[1] = Math.min(min[1], positions[i + 1]!);
    max[0] = Math.max(max[0], positions[i]!);
    max[1] = Math.max(max[1], positions[i + 1]!);
  }
  return { bounds: { min, max } };
}

export default async function page(stage: Stage): Promise<void> {
  const state = {
    projection: 'globe' as 'mercator' | 'tilt' | 'globe',
    daylight: 'noon' as 'off' | 'now' | 'noon',
    atmosphere: true,
    graticule: false,
    color: 'level' as BusColor,
    buses: true,
    lines: true,
    machines: true,
    labels: false,
    mapLabels: true,
    statesBy: 'none' as 'none' | StateField,
    flow: false,
  };
  let grid: Grid | undefined;
  let map: { choice: MapChoice; loaded: Loaded } | undefined;
  let joined: Joined | undefined;

  const scene = (): Scene => ({
    space: {
      earth: {
        projection: state.projection === 'globe' ? 'globe' : 'mercator',
        surface: LOOK.ground,
        graticule: state.graticule,
        atmosphere: state.atmosphere,
        ...(state.daylight === 'off'
          ? {}
          : { daylight: state.daylight === 'now' ? Date.now() / 1000 : NOON }),
      },
    },
    theme: {
      base: 'dark',
      background: LOOK.background,
      area: LOOK.fill,
      atmosphere: '#5aa9ff99',
      night: 0.28,
      glow: 5,
    },
    controls: { selectBox: true },
    marks: [...mapMarks(), ...gridMarks()],
  });

  /** The map's marks, its states colored as chosen. */
  const mapMarks = (): Mark[] => {
    if (!map) return [];
    const by = state.statesBy;
    const states =
      by !== 'none' && joined
        ? { by, peak: joined.peaks[by], colormap: STATE_COLORMAPS[by] }
        : undefined;
    return map.loaded.marks({ labels: state.mapLabels, ...(states ? { states } : {}) });
  };

  /** What the grid draws, as the panel says. */
  const gridMarks = (): Mark[] => {
    if (!grid?.buses) return [];
    const marks: Mark[] = [];
    const big = grid.buses > 20_000;
    if (!grid.case) {
      if (state.lines)
        marks.push({
          edges: { of: ['grid', 'Line'], ends: ['from', 'to'], width: 0.6, pick: false },
        });
      if (state.buses)
        marks.push({
          vertices: {
            of: ['grid', 'Bus'],
            position: ['lon', 'lat'],
            color: field('load').colormap('viridis').domain(0, 1),
            radius: 1.2,
          },
        });
      return marks;
    }
    const level = field('level').colormap({ kind: 'categorical', colors: LEVEL_COLORS });
    if (state.lines)
      marks.push({
        edges: {
          of: ['grid', 'Line'],
          ends: ['from', 'to'],
          // Lines of higher voltage draw on top, and stay drawn as the camera pulls back.
          priority: 'level',
          color: level,
          width: field('level')
            .scale(big ? 0.5 : 0.8, big ? 1.8 : 2.8)
            .domain(0, 5),
          dash: 'transformer',
          ...(state.flow ? { flow: field('level').mul(6).add(8) } : {}),
        },
      });
    if (state.buses) {
      const color =
        state.color === 'level'
          ? level
          : field(state.color)
              .colormap(BUS_COLORS[state.color].colormap)
              .domain(0, Math.max(1, grid.peaks[state.color]));
      marks.push({
        vertices: {
          of: ['grid', 'Bus'],
          position: ['lon', 'lat'],
          color,
          // Where buses crowd, those of higher voltage stand out, on top and from farther out.
          priority: 'level',
          radius: big ? field('level').scale(0.8, 2.6).domain(0, 5) : grid.buses > 5000 ? 2 : 3,
          ...(state.labels && grid.case.named
            ? { label: { text: 'name', priority: 'kv', size: 10 } }
            : {}),
        },
      });
    }
    const simulation = grid.case.simulation;
    if (state.machines && grid.case.machines)
      marks.push({
        vertices: {
          of: ['grid', 'Machine'],
          position: ['lon', 'lat'],
          marker: 'diamond',
          color: simulation
            ? field('speed').colormap('coolwarm').domain(-simulation.largest, simulation.largest)
            : '#ebf0f7',
          radius: field('power')
            .scale(big ? 2 : 3, big ? 5 : 8)
            .domain(0, Math.max(1, grid.peaks.power)),
        },
      });
    if (simulation?.fault)
      marks.push({
        vertices: {
          of: ['grid', 'Fault'],
          position: ['lon', 'lat'],
          color: '#ff3829',
          radius: 9,
          marker: 'rounded',
        },
      });
    return marks;
  };

  const view = stage.view(scene(), {
    label: 'A grid over the earth: drag to pan, Shift-drag to turn, hover or click to inspect',
  });
  const restyle = () => view.show(scene());
  /** Frames the grid, whatever the map beneath it spans. */
  const frame = () => view.fit(grid?.bounds ?? 'all');
  const legend = stage.legend();
  const credit = stage.credit();

  // ── Grid ──
  const gridSection = stage.section('Grid');
  gridSection.choice(
    'Grid',
    GRIDS.map(([label, id]) => [label, id] as const),
    GRIDS[0][1] as GridId,
    (id) => void loadGrid(id).catch(stage.fail),
  );
  const colorBy = gridSection.choice(
    'Color buses by',
    (Object.keys(BUS_COLORS) as BusColor[]).map((key) => [BUS_COLORS[key].label, key] as const),
    state.color,
    (color) => {
      state.color = color;
      restyle();
      showLegend();
    },
  );
  const levels = gridSection.series(LEVELS.map((label, i) => ({ label, color: LEVEL_COLORS[i]! })));
  const gridSummary = gridSection.note();

  // ── Simulation ──
  const simulationSection = stage.section('Simulation');
  simulationSection.choice(
    'Rate',
    [
      ['0.1×', 0.1],
      ['0.25×', 0.25],
      ['1×', 1],
    ] as const,
    0.25,
    (rate) => (playback.rate = rate),
  );
  const simulationSummary = simulationSection.note();
  const playback = stage.playback({
    live: false,
    rate: 0.25,
    show(at) {
      view.at = at;
      inspect();
    },
  });

  // ── Map ──
  const mapSection = stage.section('Map');
  mapSection.choice(
    'Map',
    [['None', undefined] as const, ...MAPS.map((m) => [m.label, m] as const)],
    MAPS[0] as MapChoice | undefined,
    (choice) => void loadMap(choice).catch(stage.fail),
  );
  const statesBy = mapSection.choice(
    'Color states by',
    [
      ['nothing', 'none'] as const,
      ...(Object.keys(STATE_FIELDS) as StateField[]).map(
        (k) => [STATE_FIELDS[k].label, k] as const,
      ),
    ],
    'none' as 'none' | StateField,
    (by) => {
      state.statesBy = by;
      join();
    },
  );
  const mapSummary = mapSection.note();

  // ── View ──
  const viewSection = stage.section('View');
  viewSection.choice(
    'Projection',
    [
      ['Globe', 'globe'],
      ['Map', 'mercator'],
      ['Tilted map', 'tilt'],
    ] as const,
    state.projection,
    (projection) => {
      state.projection = projection;
      restyle();
      const camera = view.camera;
      if ('center' in camera) view.fly({ ...camera, pitch: projection === 'tilt' ? 50 : 0 });
    },
  );
  viewSection.choice(
    'Daylight',
    [
      ['Noon, midsummer', 'noon'],
      ['Now', 'now'],
      ['Off', 'off'],
    ] as const,
    state.daylight,
    (daylight) => {
      state.daylight = daylight;
      restyle();
    },
  );
  viewSection.toggle('Atmosphere', 'a', state.atmosphere, (on) => {
    state.atmosphere = on;
    restyle();
  });
  viewSection.toggle('Graticule', 'g', state.graticule, (on) => {
    state.graticule = on;
    restyle();
  });
  viewSection.toggle('Turn', 't', false, (on) => (view.orbit = on ? 4 : 0));
  viewSection.actions([{ label: 'Fit the grid', key: 'f', run: frame }]);

  // ── Layers ──
  const layers = stage.section('Layers');
  const layer = (
    label: string,
    key: string,
    name: 'buses' | 'lines' | 'machines' | 'labels' | 'mapLabels' | 'flow',
  ) =>
    layers.toggle(label, key, state[name], (on) => {
      state[name] = on;
      restyle();
    });
  layer('Buses', 'b', 'buses');
  layer('Lines', 'l', 'lines');
  layer('Machines', 'm', 'machines');
  layer('Bus labels', 'n', 'labels');
  layer('Map labels', 'p', 'mapLabels');
  layer('Comets', 'c', 'flow');

  // ── Inspector ──
  const inspector = stage.section('Inspector');
  const described = inspector.note('Hover or click anything.');
  const list = document.createElement('dl');
  list.className = 'fields';
  inspector.element.append(list);
  let hovered: Row | null = null;
  const inspect = () => {
    const row = hovered ?? view.selection[0];
    list.replaceChildren();
    if (!row) return void (described.textContent = 'Hover or click anything.');
    const data = view.data(row.data);
    if (!data) return;
    const value = (name: string) => data.get(row.table, row.id, name, view.at);
    const fields = data.fields(row.table).filter((name) => !HIDDEN.test(name));
    const name = fields.find((f) => /^name$/i.test(f));
    described.textContent = `${row.table} · ${name ? format(value(name)) : `#${row.id}`}${hovered ? '' : ' · selected'}`;
    // The grid's figures first, then the rest, leaving out what this row has no value for.
    const first = fields.filter((f) => f in STATE_FIELDS);
    let shown = 0;
    for (const f of [...first, ...fields.filter((f) => f !== name && !(f in STATE_FIELDS))]) {
      const v = value(f);
      if (v === null || v === undefined || v === '' || Number.isNaN(v)) continue;
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = f in STATE_FIELDS ? STATE_FIELDS[f as StateField].label : f;
      dd.textContent = format(v) + (f in STATE_FIELDS ? STATE_FIELDS[f as StateField].unit : '');
      list.append(dt, dd);
      if (++shown === 18) break;
    }
  };
  view.on('hover', (hit: Hit | null) => {
    hovered = hit?.row ?? null;
    inspect();
  });
  view.on('select', inspect);

  const meter = stage.meter(view);
  const thousands = (n: number) => `${(n / 1000).toFixed(0)}k`;
  meter.note(() => `${thousands(view.stats.drawn)} of ${thousands(view.stats.rows)} rows drawn`);
  meter.note(
    () =>
      `${(view.stats.resident / 1e6).toFixed(0)} of ${(view.stats.budget / 1e6).toFixed(0)} MB on the GPU`,
  );

  function showLegend(): void {
    levels.hidden = !grid?.case || state.color !== 'level';
    const simulation = grid?.case?.simulation;
    if (state.statesBy !== 'none' && joined)
      return legend.ramp(
        STATE_COLORMAPS[state.statesBy],
        `${STATE_FIELDS[state.statesBy].label} 0 – ${fixed(joined.peaks[state.statesBy])}${STATE_FIELDS[state.statesBy].unit}`,
      );
    if (simulation && state.machines)
      return legend.ramp('coolwarm', `machine speed ±${fixed(simulation.largest)} mHz`);
    if (!grid?.case) return legend.ramp('viridis', 'distance from the middle');
    if (state.color === 'level') return legend.ramp('grays', 'buses by voltage level');
    const { colormap, label } = BUS_COLORS[state.color];
    legend.ramp(colormap, `${label} 0 – ${fixed(grid.peaks[state.color])} MW`);
  }

  /** The grid's figures in the map's states, when it has states, and what they color by. */
  function join(): void {
    joined = undefined;
    const states = map?.loaded.states;
    if (states && grid?.case && state.statesBy !== 'none') {
      joined = joinStates(states, grid.case);
      view.setData(joined.data);
      mapSummary.textContent = `${map!.loaded.summary} · the grid reaches ${joined.states} states`;
    }
    restyle();
    showLegend();
  }

  let gridLoad: AbortController | undefined;
  async function loadGrid(id: GridId): Promise<void> {
    gridLoad?.abort();
    const load = (gridLoad = new AbortController());
    const label = GRIDS.find((g) => g[1] === id)![0];
    stage.detail(`${label}: loading…`);
    const started = performance.now();
    let next: Grid;
    if (id.startsWith('lattice')) {
      const built = lattice(id);
      view.setData(built.data);
      next = {
        id,
        label,
        buses: built.buses,
        lines: built.lines,
        bounds: built.bounds,
        peaks: { load: 1, generation: 0, power: 0 },
        summary: `built in ${(performance.now() - started).toFixed(0)} ms`,
      };
    } else {
      const found = id.startsWith('continent') ? continent(id) : await loadCase(id, load.signal);
      if (load.signal.aborted) return;
      view.setData(found.data);
      const peak = (values: Float32Array) => values.reduce((top, v) => Math.max(top, v), 0);
      next = {
        id,
        label,
        buses: found.buses,
        lines: found.lines,
        case: found,
        bounds: extent(found.positions),
        peaks: {
          load: peak(found.load),
          generation: peak(found.generation),
          power: peak(found.machinePower),
        },
        summary: found.bytes
          ? `${(found.bytes / 1e6).toFixed(2)} MB in ${(performance.now() - started).toFixed(0)} ms`
          : `built in ${(performance.now() - started).toFixed(0)} ms`,
      };
    }
    grid = next;
    view.select([]);
    hovered = null;
    const simulation = next.case?.simulation;
    simulationSection.element.hidden = !simulation;
    playback.hidden = !simulation;
    colorBy.disabled = !next.case;
    playback.pause();
    playback.record(simulation ? [0, simulation.duration] : [0, 0]);
    view.at = 0;
    simulationSummary.textContent = simulation
      ? `${simulation.frames} frames over ${simulation.duration.toFixed(0)} s` +
        (simulation.fault
          ? ` · fault at ${simulation.fault.bus}, ${simulation.fault.on.toFixed(2)}–${simulation.fault.off.toFixed(2)} s`
          : '')
      : '';
    gridSummary.textContent =
      `${next.buses.toLocaleString()} buses · ${next.lines.toLocaleString()} lines` +
      (next.case ? ` · ${next.case.machines.toLocaleString()} machines` : '') +
      ` · ${next.summary}`;
    statesBy.disabled = !next.case || !map?.loaded.states;
    join();
    frame();
    stage.detail(`${label} · ${next.summary}`);
    inspect();
  }

  let mapLoad: AbortController | undefined;
  async function loadMap(choice: MapChoice | undefined): Promise<void> {
    mapLoad?.abort();
    const load = (mapLoad = new AbortController());
    map?.loaded.unload(view);
    map = undefined;
    joined = undefined;
    credit.textContent = '';
    mapSummary.textContent = choice ? 'loading…' : '';
    restyle();
    if (!choice) return;
    const loaded = await choice.load(view, load.signal);
    if (load.signal.aborted) return loaded.unload(view);
    map = { choice, loaded };
    credit.textContent = choice.attribution;
    mapSummary.textContent = loaded.summary;
    statesBy.disabled = !grid?.case || !loaded.states;
    join();
  }

  showLegend();
  await Promise.all([loadGrid(GRIDS[0][1]), loadMap(MAPS[0])]);
}

/** A value read from a dataset, written for the inspector. */
function format(value: unknown): string {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'number')
    return Number.isInteger(value) ? value.toLocaleString() : value.toPrecision(4);
  if (typeof value === 'object' && 'id' in value) return String((value as Row).id);
  return typeof value === 'object' ? JSON.stringify(value) : String(value as string | boolean);
}
