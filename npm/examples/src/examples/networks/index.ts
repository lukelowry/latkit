/**
 * A grid at scale over the earth. Choose a synthetic grid, from WECC 240-bus to ACTIVSg70k, a
 * continent's grid of two million buses built in the page, or a lattice of up to a million buses,
 * and the map beneath it: coasts and borders, Natural Earth's states colored by the grid's figures,
 * or OpenStreetMap's planet as vector tiles. Play a simulated fault and watch the machines' speeds
 * swing; turn the globe at noon or now; find a bus by name; hover or click anything to inspect it.
 * The panels below change how buses, lines, and labels draw, how focus and comets look, and how the
 * view answers the pointer and the keys.
 */
import {
  Patch,
  color,
  field,
  hovered,
  missing,
  pointer,
  reference,
  selected,
  units,
  when,
  zoom,
  type ColormapName,
  type Controls,
  type Expr,
  type Fit,
  type Mark,
  type Marker,
  type Row,
  type Scene,
  type Size,
  type Zoom,
} from '../../latkit.js';
import { h } from '../../ui/dom.js';
import { each } from '../../ui/rows.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';
import { LEVELS, loadCase, megabytes, type Case } from './cases.js';
import { continent } from './continent.js';
import { lattice } from './lattice.js';
import { LOOK, MAPS, type Loaded, type MapChoice } from './maps.js';
import { STATE_FIELDS, joinStates, type Joined, type StateField } from './states.js';

/** The grids the page draws, synthetic cases first. */
const GRIDS = [
  ['WECC 240', 'wecc240'],
  ['ACTIVSg2000', 'activsg2000'],
  ['ACTIVSg10k', 'activsg10k'],
  ['ACTIVSg25k', 'activsg25k'],
  ['ACTIVSg70k', 'activsg70k'],
  ['North America · 2M', 'continent-2m'],
  ['Lattice · 100K', 'lattice-100k'],
  ['Lattice · 1M', 'lattice-1m'],
  ['None', 'none'],
] as const;
type GridId = (typeof GRIDS)[number][1];

/** Each voltage level's color, from below 100 kV to 765 kV. */
const LEVEL_COLORS = ['#56657a', '#2fa49b', '#7fc97f', '#e6c84f', '#f08a3c', '#e5486f'];
const BUS_COLORS = {
  level: { label: 'voltage level', colormap: undefined },
  plain: { label: 'plain', colormap: undefined },
  load: { label: 'load', colormap: 'mako' },
  generation: { label: 'generation', colormap: 'amber' },
} as const satisfies Record<string, { label: string; colormap: ColormapName | undefined }>;
type BusColor = keyof typeof BUS_COLORS;
/** A label as an option shows it, its first letter a capital. */
const option = (label: string) => label[0]!.toUpperCase() + label.slice(1);
const STATE_COLORMAPS: Readonly<Record<StateField, ColormapName>> = {
  buses: 'viridis',
  load: 'mako',
  generation: 'amber',
  swing: 'inferno',
};
/** How a bus's marker is drawn: a shape by name, or the shape option. */
const MARKERS = {
  circle: { shape: 'ellipse' },
  square: 'rectangle',
  rounded: 'rounded',
  diamond: 'diamond',
} as const satisfies Record<string, Marker>;
/** The fonts labels may be set in. */
const FONTS = {
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, serif',
  mono: 'ui-monospace, monospace',
} as const;
/** Degrees on a side of the squares buses are zoned by. */
const ZONE = 4;
/** Fields the inspector leaves out: where a row is, which the view shows, and translations. */
const HIDDEN = /^(lon|lat|geometry|position|zone|name_.*|name:.*)$/;
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
  /** The box its buses stand in, which framing the grid shows; none for the map alone. */
  readonly bounds?: Fit;
  /** Whether its buses are zoned: grouped by the square of the map they stand in. */
  readonly zoned: boolean;
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

/** A case's buses zoned by the `ZONE`-degree square each stands in: a zone for each square, and a
 * reference from each bus to its zone, which an edges mark draws as a star joining its buses. */
function zones(found: Case): Patch {
  const ids = found.data.ids('Bus');
  const squares = new Map<number, number>();
  const zone = new Uint32Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const x = Math.floor(found.positions[i * 2]! / ZONE);
    const y = Math.floor(found.positions[i * 2 + 1]! / ZONE);
    const key = (x + 1000) * 1000 + y + 1000;
    let z = squares.get(key);
    if (z === undefined) squares.set(key, (z = squares.size));
    zone[i] = z;
  }
  const hue = Float64Array.from({ length: squares.size }, (_, z) => z % 20);
  return new Patch()
    .set('Zone', { count: squares.size }, { hue })
    .set('Bus', ids, { zone: reference('Zone', zone) });
}

export default async function page(stage: Stage): Promise<void> {
  const state = {
    projection: 'globe' as 'mercator' | 'tilt' | 'globe' | 'plane',
    daylight: 'noon' as 'off' | 'now' | 'noon',
    atmosphere: true,
    graticule: false,
    color: 'level' as BusColor,
    buses: true,
    lines: true,
    machines: true,
    zones: false,
    labels: false,
    mapLabels: true,
    statesBy: 'none' as 'none' | StateField,
    flow: false,
  };
  /** How buses, lines, labels, focus, and comets look. */
  const look = {
    marker: 'circle' as keyof typeof MARKERS,
    size: 'pixels' as 'pixels' | 'zoom' | 'units',
    emphasis: 'none' as 'none' | 'hovered' | 'selected' | 'pointer',
    route: 'geodesic' as 'geodesic' | 'straight',
    arrows: false,
    width: 1,
    lineColor: 'level' as 'level' | 'ends' | 'theme',
    bow: 0.12,
    labelSize: 10,
    labelMax: 0,
    font: 'sans' as keyof typeof FONTS,
    wrap: 0,
    glow: 5,
    dim: 0.35,
    halo: 2,
    hoverScale: 1.25,
    night: 0.28,
    comets: 'screen' as 'screen' | 'map',
    cometScale: 1,
    /** The bus a search found, ringed. */
    found: '',
  };
  /** How the view answers the pointer and the keys. */
  const interaction = {
    preset: 'explore' as 'explore' | 'inspect' | 'none',
    zoom: 'wheel' as Zoom,
    pan: true,
    turn: true,
    keyboard: true,
    hover: true,
    cycle: false,
    selectBox: true,
    pickRadius: 6,
  };
  let grid: Grid | undefined;
  let map: { choice: MapChoice; loaded: Loaded } | undefined;
  let joined: Joined | undefined;

  const controls = (): Controls =>
    interaction.preset !== 'explore'
      ? interaction.preset
      : {
          pan: interaction.pan,
          zoom: interaction.zoom,
          turn: interaction.turn,
          keyboard: interaction.keyboard,
          hover: interaction.hover,
          cycle: interaction.cycle,
          selectBox: interaction.selectBox,
          pickRadius: interaction.pickRadius,
        };

  const scene = (): Scene => ({
    space:
      state.projection === 'plane'
        ? 'plane'
        : {
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
      ...theme,
      area: LOOK.fill,
      atmosphere: '#5aa9ff99',
      night: look.night,
      glow: look.glow,
      dim: look.dim,
      halo: look.halo,
      hoverScale: look.hoverScale,
      laneBow: look.bow,
      // Marks without a color of their own take the theme's: plain buses and lines; lines set to
      // blend take the colors of the buses they join.
      vertex: '#d9e2ec',
      edge: look.lineColor === 'ends' ? null : '#8fa3b8',
      // Comets kept soft, as rivers carry them across the map too: on screen, pixels apart; on the
      // map, degrees apart, so they zoom with it.
      flow:
        look.comets === 'map'
          ? {
              color: '#d6e6ffa6',
              width: 3 * look.cometScale,
              length: 0.35 * look.cometScale,
              spacing: 1.2 * look.cometScale,
              units: true,
            }
          : {
              color: '#d6e6ffa6',
              width: 3 * look.cometScale,
              length: 20 * look.cometScale,
              spacing: 72 * look.cometScale,
            },
    },
    controls: controls(),
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

  /** A bus's radius, `base` CSS pixels, as the panel says: grown where it is hovered, selected, or
   * near the pointer; grown with the zoom, or sized on the map and kept within pixels. */
  const busRadius = (base: Expr | number): Size => {
    const emphasis = {
      none: 1,
      hovered: when(hovered()).then(2.2).otherwise(1),
      selected: when(selected()).then(2.2).otherwise(1),
      // A lens: up to 2.6 times as large at the pointer, back to 1 eighty pixels out.
      pointer: pointer().div(80).neg().add(1).max(0).mul(1.6).add(1),
    }[look.emphasis];
    const radius = typeof emphasis === 'number' ? base : emphasis.mul(base);
    if (look.size === 'zoom') return zoom().sub(3).mul(0.5).clamp(0.6, 3).mul(radius);
    if (look.size === 'units')
      return units(typeof radius === 'number' ? radius * 0.03 : radius.mul(0.03), {
        atLeast: 1,
        atMost: 16,
      });
    return radius;
  };

  /** What the grid draws, as the panel says. */
  const gridMarks = (): Mark[] => {
    if (!grid?.buses) return [];
    const marks: Mark[] = [];
    const big = grid.buses > 20_000;
    if (!grid.case) {
      if (state.lines)
        marks.push({
          edges: {
            of: ['grid', 'Line'],
            ends: ['from', 'to'],
            width: 0.6 * look.width,
            pick: false,
            route: look.route,
            arrows: look.arrows,
          },
        });
      if (state.buses)
        marks.push({
          vertices: {
            of: ['grid', 'Bus'],
            position: ['lon', 'lat'],
            color: field('load').colormap('viridis').domain(0, 1),
            radius: busRadius(1.2),
            marker: MARKERS[look.marker],
          },
        });
      return marks;
    }
    const level = field('level').colormap({ kind: 'categorical', colors: LEVEL_COLORS });
    if (state.zones && grid.zoned)
      marks.push({
        edges: {
          of: ['grid', 'Zone'],
          joins: ['Bus', 'zone'],
          color: field('hue').colormap('tab20'),
          width: 0.8,
          pick: false,
        },
      });
    if (state.lines)
      marks.push({
        edges: {
          of: ['grid', 'Line'],
          ends: ['from', 'to'],
          // Lines of higher voltage draw on top, and stay drawn as the camera pulls back.
          priority: 'level',
          ...(look.lineColor === 'level' ? { color: level } : {}),
          width: field('level')
            .scale((big ? 0.5 : 0.8) * look.width, (big ? 1.8 : 2.8) * look.width)
            .domain(0, 5),
          dash: 'transformer',
          route: look.route,
          arrows: look.arrows,
          ...(state.flow ? { flow: field('level').mul(6).add(8) } : {}),
        },
      });
    if (state.buses) {
      const busColor =
        state.color === 'level'
          ? level
          : state.color === 'plain'
            ? undefined
            : field(state.color)
                .colormap(BUS_COLORS[state.color].colormap)
                .domain(0, Math.max(1, grid.peaks[state.color]));
      marks.push({
        vertices: {
          of: ['grid', 'Bus'],
          position: ['lon', 'lat'],
          ...(busColor ? { color: busColor } : {}),
          // Where buses crowd, those of higher voltage stand out, on top and from farther out.
          priority: 'level',
          radius: busRadius(
            big ? field('level').scale(0.8, 2.6).domain(0, 5) : grid.buses > 5000 ? 2 : 3,
          ),
          marker: MARKERS[look.marker],
          // The bus a search found is ringed.
          ...(look.found
            ? {
                ring: when(field('name').is(look.found))
                  .then(color('#ffd166'))
                  .otherwise(missing()),
              }
            : {}),
          ...(state.labels && grid.case.named
            ? {
                label: {
                  text: 'name',
                  priority: 'kv',
                  size: look.labelSize,
                  font: FONTS[look.font],
                  ...(look.labelMax ? { max: look.labelMax } : {}),
                  ...(look.wrap ? { maxWidth: look.wrap } : {}),
                },
              }
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
  // Fits keep clear of the readout over the view's top and the credit and legend over its foot.
  view.insets = [32, 16, 32, 16];
  const restyle = () => view.show(scene());
  /** Frames the grid, whatever the map beneath it spans; the map alone, all of it. */
  const frame = () => view.fit(grid?.bounds ?? 'all');
  const legend = stage.legend();
  const credit = stage.credit();
  const canvas = stage.regions.main.querySelector('canvas')!;
  // A search's first bus wears a tag on the map, which follows it as the camera moves.
  const tag = h('p', { class: 'callout', hidden: true });
  stage.regions.main.append(tag);
  let tagged: [number, number, number] | undefined;
  stage.frame(() => tagged && pin());

  // ── Grid ──
  const gridSection = stage.section('Grid');
  gridSection.choice(
    'Grid',
    GRIDS.map(([label, id]) => [label, id] as const),
    GRIDS[0][1] as GridId,
    (id) => void loadGrid(id).catch(stage.fail),
  );
  const colorBy = gridSection.choice(
    'Bus color',
    (Object.keys(BUS_COLORS) as BusColor[]).map(
      (key) => [option(BUS_COLORS[key].label), key] as const,
    ),
    state.color,
    (next) => {
      state.color = next;
      restyle();
      showLegend();
    },
  );
  const levels = gridSection.series(LEVELS.map((label, i) => ({ label, color: LEVEL_COLORS[i]! })));
  const gridSummary = gridSection.note();

  // ── Simulation ──
  const simulationSection = stage.section('Simulation');
  simulationSection.speed([0.1, 0.25, 1], 0.25, (rate) => (playback.rate = rate));
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
    'State color',
    [
      ['Nothing', 'none'] as const,
      ...(Object.keys(STATE_FIELDS) as StateField[]).map(
        (k) => [option(STATE_FIELDS[k].label), k] as const,
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
      ['Plane', 'plane'],
    ] as const,
    state.projection,
    (projection) => {
      const flat = state.projection === 'plane' || projection === 'plane';
      state.projection = projection;
      restyle();
      // Between the earth and a plane, positions mean other units: frame the grid again.
      if (flat) return frame();
      const camera = view.camera;
      if ('center' in camera) view.fly({ ...camera, pitch: projection === 'tilt' ? 50 : 0 });
    },
  );
  viewSection.choice(
    'Daylight',
    [
      ['Noon', 'noon'],
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
  viewSection.toggle('Grid', 'g', state.graticule, (on) => {
    state.graticule = on;
    restyle();
  });
  viewSection.toggle('Orbit', 't', false, (on) => (view.orbit = on ? 4 : 0));
  viewSection.actions([{ label: 'Fit', key: 'f', run: frame }]);
  // Where the pointer meets the ground, and where the camera stands, as the view tells it.
  const where = viewSection.note('Point at the map.');
  const camera = viewSection.note();
  const degrees = (value: number, [plus, minus]: string) =>
    `${Math.abs(value).toFixed(2)}° ${value >= 0 ? plus : minus}`;
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const ground = view.ground([event.offsetX, event.offsetY]);
      where.textContent = ground
        ? state.projection === 'plane'
          ? `Pointer at ${ground[0].toFixed(2)}, ${ground[1].toFixed(2)}`
          : `Pointer at ${degrees(ground[1], 'NS')}, ${degrees(ground[0], 'EW')}`
        : 'Point at the map.';
    },
    { signal: stage.signal },
  );
  view.on('camera', (at) => {
    if ('center' in at)
      camera.textContent = `Zoom ${at.zoom.toFixed(1)} · pitch ${at.pitch.toFixed(0)}° · bearing ${at.bearing.toFixed(0)}°`;
  });

  // ── Layers ──
  const layers = stage.section('Layers');
  const layer = (
    label: string,
    key: string | undefined,
    name: 'buses' | 'lines' | 'machines' | 'zones' | 'labels' | 'mapLabels' | 'flow',
  ) =>
    layers.toggle(label, key, state[name], (on) => {
      state[name] = on;
      restyle();
    });
  layer('Buses', 'b', 'buses');
  layer('Lines', 'l', 'lines');
  layer('Machines', 'm', 'machines');
  layer('Zones', 'z', 'zones');
  layer('Bus labels', 'n', 'labels');
  layer('Map labels', 'p', 'mapLabels');
  layer('Flow', 'c', 'flow');

  // ── Buses ──
  const buses = stage.section('Buses', false);
  buses.choice(
    'Marker',
    [
      ['Circle', 'circle'],
      ['Square', 'square'],
      ['Rounded', 'rounded'],
      ['Diamond', 'diamond'],
    ] as const,
    look.marker,
    (marker) => ((look.marker = marker), restyle()),
  );
  buses.choice(
    'Size',
    [
      ['Pixels', 'pixels'],
      ['Grows with zoom', 'zoom'],
      ['On the map', 'units'],
    ] as const,
    look.size,
    (size) => ((look.size = size), restyle()),
  );
  buses.choice(
    'Stand out',
    [
      ['None', 'none'],
      ['Hovered', 'hovered'],
      ['Selected', 'selected'],
      ['Near the pointer', 'pointer'],
    ] as const,
    look.emphasis,
    (emphasis) => ((look.emphasis = emphasis), restyle()),
  );
  buses.range(
    'Label size',
    { min: 8, max: 16, step: 1, value: look.labelSize, format: (v) => `${v} px` },
    (size) => {
      look.labelSize = size;
      restyle();
    },
  );
  buses.choice(
    'Most labels',
    [
      ['As many as fit', 0],
      ['100', 100],
      ['25', 25],
    ] as const,
    look.labelMax,
    (max) => ((look.labelMax = max), restyle()),
  );
  buses.choice(
    'Font',
    [
      ['Sans', 'sans'],
      ['Serif', 'serif'],
      ['Mono', 'mono'],
    ] as const,
    look.font,
    (font) => ((look.font = font), restyle()),
  );
  buses.choice(
    'Wrap labels',
    [
      ['Never', 0],
      ['At 60 px', 60],
    ] as const,
    look.wrap,
    (wrap) => ((look.wrap = wrap), restyle()),
  );

  // ── Lines ──
  const linesSection = stage.section('Lines', false);
  linesSection.choice(
    'Route',
    [
      ['Great circles', 'geodesic'],
      ['Straight', 'straight'],
    ] as const,
    look.route,
    (route) => ((look.route = route), restyle()),
  );
  linesSection.choice(
    'Color',
    [
      ['By voltage', 'level'],
      ['Blend their buses', 'ends'],
      ['Plain', 'theme'],
    ] as const,
    look.lineColor,
    (next) => ((look.lineColor = next), restyle()),
  );
  linesSection.range(
    'Width',
    { min: 0.5, max: 3, step: 0.25, value: look.width, format: (v) => `${v.toFixed(2)}×` },
    (width) => {
      look.width = width;
      restyle();
    },
  );
  linesSection.range(
    'Parallel bow',
    { min: 0, max: 0.4, step: 0.02, value: look.bow, format: (v) => `${Math.round(v * 100)}%` },
    (bow) => {
      look.bow = bow;
      restyle();
    },
  );
  linesSection.toggle('Arrows', undefined, look.arrows, (on) => ((look.arrows = on), restyle()));

  // ── Look ──
  const lookSection = stage.section('Look', false);
  const slider = (
    label: string,
    name: 'glow' | 'dim' | 'halo' | 'hoverScale' | 'night' | 'cometScale',
    o: { min: number; max: number; step: number; format: (v: number) => string },
  ) =>
    lookSection.range(label, { ...o, value: look[name] }, (value) => {
      look[name] = value;
      restyle();
    });
  slider('Glow', 'glow', { min: 0, max: 12, step: 1, format: (v) => `${v} px` });
  slider('Dim the rest', 'dim', {
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  });
  slider('Label halo', 'halo', { min: 0, max: 5, step: 0.5, format: (v) => `${v} px` });
  slider('Hover growth', 'hoverScale', {
    min: 1,
    max: 2,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×`,
  });
  slider('Night', 'night', {
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  });
  lookSection.choice(
    'Comets',
    [
      ['On screen', 'screen'],
      ['On the map', 'map'],
    ] as const,
    look.comets,
    (comets) => ((look.comets = comets), restyle()),
  );
  slider('Comet size', 'cometScale', {
    min: 0.5,
    max: 2,
    step: 0.25,
    format: (v) => `${v.toFixed(2)}×`,
  });

  // ── Interaction ──
  const reacts = stage.section('Interaction', false);
  const answer = () => restyle();
  reacts.choice(
    'Controls',
    [
      ['Explore', 'explore'],
      ['Inspect', 'inspect'],
      ['Still picture', 'none'],
    ] as const,
    interaction.preset,
    (preset) => ((interaction.preset = preset), answer()),
  );
  reacts.choice(
    'Zoom',
    [
      ['Wheel', 'wheel'],
      ['Ctrl + wheel', 'modifier'],
      ['Off', 'off'],
    ] as const,
    interaction.zoom,
    (next) => ((interaction.zoom = next), answer()),
  );
  for (const [label, name] of [
    ['Pan', 'pan'],
    ['Turn', 'turn'],
    ['Keys', 'keyboard'],
    ['Hover glow', 'hover'],
    ['Cycle picks', 'cycle'],
    ['Box select', 'selectBox'],
  ] as const)
    reacts.toggle(
      label,
      undefined,
      interaction[name],
      (on) => ((interaction[name] = on), answer()),
    );
  reacts.range(
    'Pick reach',
    { min: 0, max: 24, step: 2, value: interaction.pickRadius, format: (v) => `${v} px` },
    (radius) => {
      interaction.pickRadius = radius;
      answer();
    },
  );

  // ── Inspector ──
  const inspector = stage.section('Inspector');
  const search = inspector.text('Find', (text) => find(text.trim()));
  search.placeholder = 'A bus by name';
  const described = inspector.note('Select an item.');
  const list = document.createElement('dl');
  list.className = 'fields';
  inspector.content.append(list);
  let hoveredRow: Row | null = null;
  const inspect = () => {
    const row = hoveredRow ?? each(view.selection)[0];
    list.replaceChildren();
    if (!row) return void (described.textContent = 'Select an item.');
    const data = view.data(row.data);
    if (!data) return;
    const value = (name: string) => data.get(row.table, row.id, name, view.at);
    const fields = data.fields(row.table).filter((name) => !HIDDEN.test(name));
    const name = fields.find((f) => /^name$/i.test(f));
    described.textContent = `${row.table} · ${name ? format(value(name)) : `#${row.id}`}${hoveredRow ? '' : ' · selected'}`;
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
  view.on('hover', ({ hit }) => {
    hoveredRow = hit?.row ?? null;
    inspect();
  });
  view.on('select', inspect);

  /** Puts the tag where its bus now stands on screen, or hides it where none shows. */
  function pin(): void {
    const point = tagged && view.point(tagged);
    tag.hidden = !point;
    if (point) tag.style.translate = `${point[0]}px ${point[1]}px`;
  }
  /** Selects every bus whose name holds `text`, frames them, and tags the first. */
  function find(text: string): void {
    const data = view.data('grid');
    tagged = undefined;
    look.found = '';
    if (!text || !data?.tables.includes('Bus') || !grid?.case?.named) {
      pin();
      restyle();
      if (text) described.textContent = 'This grid has no named buses.';
      return;
    }
    const found = data.query({
      of: 'Bus',
      filter: field('name').contains(text),
      sort: [['kv', 'descending']],
      limit: 200,
      select: { name: 'name', lon: 'lon', lat: 'lat' },
    });
    if (!found.ids.length) {
      pin();
      restyle();
      described.textContent = `No bus is named like ${text}.`;
      return;
    }
    const rows = [{ data: 'grid', table: 'Bus', ids: found.ids }];
    const first: Row = { data: 'grid', table: 'Bus', id: found.ids[0]! };
    const names = found.fields.name as string[];
    const [lon, lat] = [found.fields.lon as Float64Array, found.fields.lat as Float64Array];
    look.found = names[0]!;
    restyle();
    view.select(rows);
    // One found is brought into view as the camera stands; more are framed together.
    view.fit(found.ids.length === 1 ? { reveal: first } : { rows });
    tagged = [lon[0]!, lat[0]!, 0];
    tag.textContent = names[0]!;
    pin();
    described.textContent = `${found.total.toLocaleString()} buses named like ${text}${found.total > found.ids.length ? `, the ${found.ids.length} of highest voltage selected` : ''}.`;
  }

  stage.meter(view).note(() => {
    const k = (n: number) => `${(n / 1000).toFixed(0)}k`;
    return `${k(view.stats.drawn)} of ${k(view.stats.rows)} rows drawn`;
  });

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
    if (state.color === 'plain') return legend.ramp('grays', 'buses');
    const { colormap, label } = BUS_COLORS[state.color];
    legend.ramp(colormap, `${label} 0 – ${fixed(grid.peaks[state.color])} MW`);
  }

  /** The grid's figures in the map's states, when it has states, and what they color by. */
  function join(): void {
    joined?.data.destroy();
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
    if (id === 'none') {
      view.removeData('grid');
      next = {
        id,
        label,
        buses: 0,
        lines: 0,
        peaks: { load: 0, generation: 0, power: 0 },
        summary: 'nothing to draw over the map',
        zoned: false,
      };
    } else if (id.startsWith('lattice')) {
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
        zoned: false,
      };
    } else {
      const found = id.startsWith('continent')
        ? continent(id)
        : await loadCase(id, load.signal, (received, total) =>
            stage.detail(`${label}: downloading ${megabytes(received, total)}`),
          );
      if (load.signal.aborted) return;
      // Cases' buses are zoned by where they stand; a continent's are too many to zone in the page.
      const zoned = found.named;
      if (zoned) found.data.apply(zones(found));
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
        zoned,
      };
    }
    grid = next;
    view.select([]);
    hoveredRow = null;
    search.value = '';
    tagged = undefined;
    look.found = '';
    pin();
    const simulation = next.case?.simulation;
    simulationSection.element.hidden = !simulation;
    playback.hidden = !simulation;
    colorBy.disabled = !next.case;
    search.disabled = !next.case?.named;
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
    const loaded = await choice.load(view, load.signal, (status) => {
      if (!load.signal.aborted) mapSummary.textContent = status;
    });
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
