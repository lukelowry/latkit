/**
 * Grid operations: a state's transmission grid as a control room watches it. Each substation is a
 * gauge of its output sized by its capacity, a plant's round and a load's square; branches are as
 * wide as their rating, color by loading, carry comets along their flow, and bow apart where they
 * run in parallel. The flows come from a DC power flow solved every tick: push demand up or trip a
 * line, and overloaded branches trip in turn, flows swing onto what is left, and loads cut off from
 * every plant go dark. Each tick eases into place; what trips pulses until it is restored.
 */
import {
  Data,
  Patch,
  elapsed,
  field,
  reference,
  when,
  type Hit,
  type Motion,
  type Scene,
} from '../latkit.js';
import type { Stage } from '../ui/stage.js';
import { Grid, KINDS } from './grid.js';
import texas from './texas.json';

/** The control room's dark theme: a quiet network, its alarms and flows bright. */
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

/** A branch's color by its loading, % of its rating: calm blues to 80%, then amber at 90% through
 * red where its protection trips it. */
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
/** The grid's state as a patch of the `grid` dataset's changing fields. */
function patchOf(grid: Grid): Patch {
  const kind = Float32Array.from(grid.kind, (k, i) =>
    grid.tripped(i) || (grid.load[i] && grid.fill[i]! < 0.05) ? KINDS.length : k,
  );
  return new Patch()
    .set('Substation', grid.n, {
      fill: grid.fill,
      kind,
      alarm: Uint8Array.from(kind, (k) => (k === KINDS.length ? 1 : 0)),
      mw: Float64Array.from(grid.injection, Math.abs),
    })
    .set('Branch', grid.m, {
      out: grid.out,
      // Overloaded or out.
      alarm: Uint8Array.from(grid.loading, (l, j) => (grid.out[j] || l > 1 ? 1 : 0)),
      flow: Float64Array.from(grid.flow, (f, j) =>
        grid.out[j] ? 0 : Math.max(-1, Math.min(1, f / grid.rating[j]!)),
      ),
      mw: Float64Array.from(grid.flow, Math.abs),
      loading: Float64Array.from(grid.loading, (l) => l * 100),
    });
}

export default async function page(stage: Stage): Promise<void> {
  // Labels set in Jura once it has loaded.
  const jura = new FontFace(
    'Jura',
    `url(${import.meta.env.BASE_URL}fonts/jura-latin-400-normal.woff2)`,
  );
  document.fonts.add(await jura.load());

  const grid = new Grid();
  const s = texas.substations;
  let data = new Data('grid').apply(
    new Patch()
      .set('Substation', grid.n, {
        name: s.map((x) => x.name),
        lon: Float64Array.from(s, (x) => x.lon),
        lat: Float64Array.from(s, (x) => x.lat),
        load: grid.load,
        capacity: grid.capacity,
      })
      .set('Branch', grid.m, {
        from: reference(
          'Substation',
          Uint32Array.from(texas.branches, (b) => b.from),
        ),
        to: reference(
          'Substation',
          Uint32Array.from(texas.branches, (b) => b.to),
        ),
        rating: grid.rating,
      }),
  );
  data = data.apply(patchOf(grid));
  const border = new Data('state').apply(
    new Patch().set('Border', 1, {
      geometry: [[...texas.border, texas.border[0]!] as [number, number][]],
    }),
  );

  const state = { comets: true, labels: true, playing: true };
  let motion: Motion = 'system';
  /** What trips pulses: red to dark red and back, twice a second. */
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
  // Comets run with the flow, in degrees a second, faster the nearer its rating, and never on a
  // branch out.
  const comets = when(field('out').gt(0.5))
    .then(0)
    .when(field('flow').lt(0))
    .then(field('flow').mul(1.8).sub(0.45))
    .otherwise(field('flow').mul(1.8).add(0.45));
  /** A substation mark: plants as round gauges, loads as square ones, in one table. */
  const substations = (name: string, load: number, shape: 'ellipse' | 'rounded') => ({
    vertices: {
      of: ['grid', 'Substation'] as [string, string],
      name,
      position: ['lon', 'lat'] as [string, string],
      visible: field('load').eq(load),
      // Both marks size every row alike, by its capacity, so branches stop at the outline that shows.
      radius: field('capacity').sqrt().scale(8, 17).domain(11, 46),
      marker: { gauge: { fill: field('fill'), shape } },
      color: kinds,
      status: when(field('alarm').gt(0.5)).then(pulse).otherwise('#00000000'),
      shadow: true,
      ...(load ? {} : { legend: 'Substations' }),
      ...(state.labels ? { label: { text: 'name', size: 12, priority: 'capacity' } } : {}),
    },
  });
  const scene = (): Scene => ({
    space: { earth: { projection: 'mercator', surface: LOOK.ground, graticule: false } },
    theme: {
      base: 'dark',
      background: LOOK.background,
      text: LOOK.text,
      hover: LOOK.hover,
      selected: LOOK.hover,
      // Comets are part of the map, in degrees: they zoom with it and stay on their branches.
      flow: { color: LOOK.comet, spacing: 1.35, length: 0.6, width: 6, units: true },
      font: 'Jura, sans-serif',
      fontSize: 12,
      halo: 3,
      glow: 6,
      laneBow: 0.22,
    },
    ease: 0.45,
    // Easing, pulses, and comets hold still where the system asks for reduced motion, unless set.
    controls: { motion },
    marks: [
      { lines: { of: ['state', 'Border'], width: 1.25, color: LOOK.border, pick: false } },
      {
        edges: {
          of: ['grid', 'Branch'],
          ends: ['from', 'to'],
          route: 'straight',
          width: field('rating').scale(1.6, 3.6).domain(300, 800),
          color: when(field('alarm').gt(0.5)).then(pulse).otherwise(LOADING),
          dash: 'out',
          legend: 'Loading, % of rating',
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
  view.setData(border);
  view.setData(data);
  const { xMin, xMax, yMin, yMax } = texas.bounds;
  view.fit({ bounds: { min: [xMin, yMin, 0], max: [xMax, yMax, 0] } });
  const restyle = () => view.show(scene());

  // ── Grid ──
  const gridSection = stage.section('Grid');
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
  layers.toggle('Comets', 'c', state.comets, (on) => ((state.comets = on), restyle()));
  layers.toggle('Labels', 'l', state.labels, (on) => ((state.labels = on), restyle()));
  layers.choice(
    'Motion',
    [
      ['As the system asks', 'system'],
      ['Full', 'full'],
      ['Reduced', 'reduced'],
    ] as const,
    motion,
    (next) => ((motion = next), restyle()),
  );

  // ── Inspector ──
  const inspector = stage.section('Inspector');
  const described = inspector.note('Hover or click a substation or branch.');
  let hovered: Hit | null = null;
  const inspect = () => {
    const row = hovered?.row ?? view.selection[0];
    if (!row) return void (described.textContent = 'Hover or click a substation or branch.');
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
  view.on('hover', ({ hit }) => ((hovered = hit), inspect()));
  view.on('select', inspect);

  const meter = stage.meter(view);
  meter.note(() => `${grid.trips} trips`);

  /** Shows the grid as it stands. */
  function show(): void {
    data = data.apply(patchOf(grid));
    view.setData(data);
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
