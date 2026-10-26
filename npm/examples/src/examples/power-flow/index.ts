/**
 * Grid operations: a state's transmission grid as a control room watches it.
 *
 * Each substation is a gauge of its output sized by its capacity (round for a plant, square for a
 * load), a pie, or an icon of its kind. A branch's width shows its rating and its color shows its
 * loading. Comets travel along each branch's flow, parallel branches bow apart, and branches can
 * bend along their corridors.
 *
 * A DC power flow is solved every tick. Push demand up or trip a line, and overloaded branches trip
 * in turn, flows shift onto the remaining branches, and loads cut off from every plant go dark.
 * Each tick eases into place, and tripped equipment pulses until it is restored.
 */
import {
  Data,
  Patch,
  elapsed,
  field,
  icon,
  reference,
  units,
  when,
  type Hit,
  type Marker,
  type Motion,
  type RgbaImage,
  type Scene,
} from 'latkit';
import { each } from '../../ui/rows.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';
import { Grid, KINDS } from './grid.js';
import texas from './texas.json';

/** The control room's dark palette: a muted network with bright alarms and flows. */
const LOOK = {
  background: '#07090c',
  ground: '#10161d',
  border: '#3b4552',
  text: '#dfe6ee',
  hover: '#53a3f2',
  comet: '#e8fff4',
  warning: '#ffc000',
  critical: '#ff6200',
  tripped: '#ff1915',
} as const;

/** A branch's color by its loading in % of its rating: blues up to 80%, then amber at 90%, turning
 * red around the trip setting. */
const LOADING = field('loading')
  .colormap({
    kind: 'sequential',
    colors: [
      '#2b3e54',
      '#2e4760',
      '#31506c',
      '#345a78',
      '#376484',
      '#3b6e8f',
      '#40799a',
      '#4a86a3',
      '#6a9eaa',
      LOOK.warning,
      '#ff8f00',
      LOOK.critical,
      LOOK.tripped,
    ],
  })
  .domain(0, 120);

/** Seconds between ticks of the simulation. */
const TICK = 0.5;

/** Draws an icon per substation kind: a disc in the kind's color with its initial. The last icon,
 * a red disc marked ×, is for substations that are tripped or dark. */
function icons(): RgbaImage[] {
  const size = 48;
  return [
    ...KINDS.map((k) => [k.color, k.label[0]!.toUpperCase()] as const),
    [LOOK.tripped, '×'] as const,
  ].map(([color, letter]) => {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d')!;
    context.fillStyle = color;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI);
    context.fill();
    context.fillStyle = '#07090c';
    context.font = `bold ${size * 0.55}px system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(letter, size / 2, size / 2 + 2);
    return context.getImageData(0, 0, size, size);
  });
}

/** Each branch's corridor bend: one point beside its midpoint, a tenth of its length out, on
 * alternating sides, like a corridor routed around obstacles between its substations. */
function corridors(): number[][][] {
  const s = texas.substations;
  return texas.branches.map((b, j) => {
    const [a, c] = [s[b.from]!, s[b.to]!];
    const [dx, dy] = [c.lon - a.lon, c.lat - a.lat];
    const side = (j % 2 ? 1 : -1) * 0.1;
    return [[(a.lon + c.lon) / 2 - dy * side, (a.lat + c.lat) / 2 + dx * side]];
  });
}
/** A patch of the `grid` dataset's changing fields, from the grid's current state. */
function patchOf(grid: Grid): Patch {
  const kind = Float32Array.from(grid.kind, (k, i) =>
    grid.tripped(i) || (grid.load[i] && grid.fill[i]! < 0.05) ? KINDS.length : k,
  );
  return new Patch()
    .set(
      'Substation',
      { count: grid.n },
      {
        fill: grid.fill,
        kind,
        alarm: Uint8Array.from(kind, (k) => (k === KINDS.length ? 1 : 0)),
        mw: Float64Array.from(grid.injection, Math.abs),
      },
    )
    .set(
      'Branch',
      { count: grid.m },
      {
        out: grid.out,
        // Overloaded or out.
        alarm: Uint8Array.from(grid.loading, (l, j) => (grid.out[j] || l > 1 ? 1 : 0)),
        flow: Float64Array.from(grid.flow, (f, j) =>
          grid.out[j] ? 0 : Math.max(-1, Math.min(1, f / grid.rating[j]!)),
        ),
        mw: Float64Array.from(grid.flow, Math.abs),
        loading: Float64Array.from(grid.loading, (l) => l * 100),
      },
    );
}

export default async function page(stage: Stage): Promise<void> {
  // Labels use the Jura font, so load it first.
  const jura = new FontFace(
    'Jura',
    `url(${import.meta.env.BASE_URL}fonts/jura-latin-400-normal.woff2)`,
  );
  document.fonts.add(await jura.load());

  const grid = new Grid();
  const s = texas.substations;
  const data = new Data('grid').apply(
    new Patch()
      .set(
        'Substation',
        { count: grid.n },
        {
          name: s.map((x) => x.name),
          lon: Float64Array.from(s, (x) => x.lon),
          lat: Float64Array.from(s, (x) => x.lat),
          load: grid.load,
          capacity: grid.capacity,
        },
      )
      .set(
        'Branch',
        { count: grid.m },
        {
          from: reference(
            'Substation',
            Uint32Array.from(texas.branches, (b) => b.from),
          ),
          to: reference(
            'Substation',
            Uint32Array.from(texas.branches, (b) => b.to),
          ),
          rating: grid.rating,
          corridor: corridors(),
        },
      ),
  );
  data.apply(patchOf(grid));
  const border = new Data('state').apply(
    new Patch().set(
      'Border',
      { count: 1 },
      {
        geometry: [[...texas.border, texas.border[0]!] as [number, number][]],
      },
    ),
  );

  const state = {
    comets: true,
    labels: true,
    playing: true,
    markers: 'gauges' as 'gauges' | 'pies' | 'icons',
    corridors: false,
    legends: true,
    labelColor: 'text' as 'text' | 'kind',
    ownGlow: false,
    ease: 0.45,
  };
  let motion: Motion = 'system';
  const ICONS = icons();
  /** The pulse of tripped equipment: red to dark red and back, twice a second. */
  const pulse = elapsed()
    .mul(4 * Math.PI)
    .sin()
    .colormap({ kind: 'sequential', colors: ['#5c0805', LOOK.tripped] })
    .domain(-1, 1);
  const kinds = field('kind').colormap({
    kind: 'categorical',
    colors: [...KINDS.map((k) => k.color), LOOK.tripped],
    categories: [...KINDS.map((k) => k.label), 'tripped or dark'],
  });
  // Comet speed in degrees per second. Comets move in the flow's direction, faster as the loading
  // rises. A speed of 0 draws none, so an out branch has no comets.
  const comets = when(field('out').gt(0.5))
    .then(0)
    .when(field('flow').lt(0))
    .then(field('flow').mul(1.8).sub(0.45))
    .otherwise(field('flow').mul(1.8).add(0.45));
  /** A substation's marker: a gauge of its output, a pie of output and headroom, or its kind's
   * icon. */
  const marker = (shape: 'ellipse' | 'rounded'): Marker =>
    state.markers === 'pies'
      ? {
          pie: {
            slices: [field('fill'), field('fill').neg().add(1)],
            colors: [LOOK.comet, '#26313d'],
            hole: 0.35,
          },
        }
      : state.markers === 'icons'
        ? icon(ICONS, field('kind'))
        : { gauge: { fill: field('fill'), shape } };
  /** A mark for the plants (round gauges) or the loads (square ones). Both marks draw the one
   * `Substation` table. */
  const substations = (name: string, load: number, shape: 'ellipse' | 'rounded') => ({
    vertices: {
      of: ['grid', 'Substation'] as [string, string],
      name,
      position: ['lon', 'lat'] as [string, string],
      visible: field('load').eq(load),
      // Both marks give every row the same radius from its capacity, so branches stop at the
      // outline that is shown.
      radius: field('capacity').sqrt().scale(8, 17).domain(11, 46),
      marker: marker(shape),
      color: kinds,
      ring: when(field('alarm').gt(0.5)).then(pulse).otherwise('#00000000'),
      ...(load || !state.legends ? {} : { legend: 'Substations' }),
      ...(state.labels
        ? {
            label: {
              text: 'name',
              size: 12,
              priority: 'capacity',
              ...(state.labelColor === 'kind' ? { color: kinds } : {}),
            },
          }
        : {}),
    },
  });
  const scene = (): Scene => ({
    space: { earth: { graticule: false } },
    theme: {
      ...theme,
      earth: { ground: LOOK.ground },
      text: { color: LOOK.text, font: 'Jura, sans-serif', size: 12, halo: 3 },
      // Selected rows glow blue, or each in its own color.
      focus: { hover: LOOK.hover, selected: state.ownGlow ? null : LOOK.hover, glow: 6 },
      // Comet spacing and length are in map units (degrees), so comets zoom with the map and stay
      // on their branches.
      flow: { color: LOOK.comet, spacing: units(1.35), length: units(0.6), width: 6 },
      edge: { bow: 0.22 },
    },
    ease: state.ease,
    // With `motion` at 'system', easing, pulses, and comets stop when the system asks for reduced
    // motion.
    controls: { motion },
    marks: [
      { lines: { of: ['state', 'Border'], width: 1.25, color: LOOK.border } },
      {
        edges: {
          of: ['grid', 'Branch'],
          ends: ['from', 'to'],
          route: 'straight',
          ...(state.corridors ? { bends: 'corridor' } : {}),
          width: field('rating').scale(1.6, 3.6).domain(300, 800),
          color: when(field('alarm').gt(0.5)).then(pulse).otherwise(LOADING),
          dash: 'out',
          ...(state.legends ? { legend: 'Loading, % of rating' } : {}),
          ...(state.comets ? { flow: comets } : {}),
        },
      },
      substations('plants', 0, 'ellipse'),
      substations('loads', 1, 'rounded'),
    ],
  });

  const view = stage.view(scene(), {
    label: 'A state’s grid: hover or click a substation or branch to inspect it',
  });
  view.sources = [border, data];
  const { xMin, xMax, yMin, yMax } = texas.bounds;
  view.fit({ bounds: { min: [xMin, yMin, 0], max: [xMax, yMax, 0] } });
  const restyle = () => (view.scene = scene());

  // ── Grid ──
  const gridSection = stage.section('Grid');
  gridSection.note('Simulated data');
  gridSection.range(
    'Demand',
    {
      min: 0.5,
      max: 1.2,
      step: 0.01,
      value: grid.demand,
      format: (v) => `${Math.round(v * 100)}%`,
    },
    (v) => (grid.demand = v),
  );
  gridSection.actions([
    { label: 'Trip a line', key: 't', run: () => (grid.tripWorst(), show()) },
    { label: 'Restore', key: 'r', run: () => (grid.restore(), show()) },
  ]);
  gridSection.toggle('Run', ' ', state.playing, (on) => (state.playing = on));
  const totals = gridSection.note();

  // ── Layers ──
  const layers = stage.section('Layers');
  layers.toggle('Flow', 'c', state.comets, (on) => ((state.comets = on), restyle()));
  layers.toggle('Labels', 'l', state.labels, (on) => ((state.labels = on), restyle()));
  layers.toggle('Corridors', 'b', state.corridors, (on) => ((state.corridors = on), restyle()));
  layers.toggle('Legends', 'g', state.legends, (on) => ((state.legends = on), restyle()));
  layers.choice(
    'Substations',
    [
      ['Gauges', 'gauges'],
      ['Pies', 'pies'],
      ['Icons', 'icons'],
    ] as const,
    state.markers,
    (next) => ((state.markers = next), restyle()),
  );
  layers.choice(
    'Label color',
    [
      ['Text', 'text'],
      ['By kind', 'kind'],
    ] as const,
    state.labelColor,
    (next) => ((state.labelColor = next), restyle()),
  );
  layers.choice(
    'Selection glow',
    [
      ['Blue', false],
      ['Its own color', true],
    ] as const,
    state.ownGlow,
    (next) => ((state.ownGlow = next), restyle()),
  );
  layers.choice(
    'Motion',
    [
      ['System', 'system'],
      ['Full', 'full'],
      ['Reduced', 'reduced'],
    ] as const,
    motion,
    (next) => ((motion = next), restyle()),
  );
  layers.range(
    'Easing',
    { min: 0, max: 1.5, step: 0.05, value: state.ease, format: (v) => `${v.toFixed(2)} s` },
    (ease) => {
      state.ease = ease;
      restyle();
    },
  );

  // ── Inspector ──
  const inspector = stage.section('Inspector');
  const described = inspector.note('Select a substation or line.');
  let hovered: Hit | null = null;
  const inspect = () => {
    const row = hovered?.row ?? each(view.selection)[0];
    if (!row) return void (described.textContent = 'Select a substation or line.');
    const value = (name: string) => data.get(row.table, row.id, name) as number;
    const i = Number(row.id);
    if (row.table === 'Substation') {
      const what = grid.load[i] ? 'load' : KINDS[grid.kind[i]!]!.label;
      const status = grid.tripped(i)
        ? 'tripped'
        : grid.load[i] && grid.fill[i]! < 0.05
          ? 'dark'
          : `${Math.round(grid.fill[i]! * 100)}%`;
      described.textContent = `${s[i]!.name} · ${what} · ${Math.round(value('mw'))} of ${Math.round(grid.capacity[i]!)} MW · ${status}`;
    } else {
      const b = texas.branches[i]!;
      const [from, to] = grid.flow[i]! >= 0 ? [b.from, b.to] : [b.to, b.from];
      described.textContent = grid.out[i]
        ? `${s[b.from]!.name}–${s[b.to]!.name} · out`
        : `${s[from]!.name} → ${s[to]!.name} · ${Math.round(value('mw'))} MW · ${Math.round(value('loading'))}% of ${b.pmax} MW`;
    }
  };
  view.on('hovered', ({ hit }) => ((hovered = hit), inspect()));
  view.on('selection', inspect);

  const meter = stage.meter(view);
  meter.note(() => `${grid.trips} trips`);

  /** Shows the grid's current state in the view, the totals, and the inspector. */
  function show(): void {
    data.apply(patchOf(grid));
    const served = grid.injection.reduce((sum, p, i) => sum + (grid.load[i] ? -p : 0), 0);
    const out = grid.out.reduce((a, b) => a + b, 0);
    totals.textContent = `${Math.round(served).toLocaleString()} MW served · ${out} branches out · ${grid.dark} loads dark`;
    inspect();
  }

  let carry = 0;
  stage.frame((dt) => {
    if (!state.playing) return;
    carry += dt;
    if (carry < TICK) return;
    carry -= TICK;
    grid.step(TICK);
    show();
  });
  show();
  stage.detail(`${grid.n} substations · ${grid.m} branches, ${texas.name}`);
}
