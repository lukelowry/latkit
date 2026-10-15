/**
 * Grid operations: a state's transmission grid as a control room watches it. Each substation is a
 * gauge of its output, a plant's round and a load's square; branches color by loading, carry comets
 * along their flow, and bow apart where they run in parallel. The flows come from a DC power flow
 * solved every tick: push demand up or trip a line, and overloaded branches trip in turn, flows
 * swing onto what is left, and loads cut off from every plant go dark. Each tick eases into place;
 * what trips pulses until it is restored.
 */
import { Data, Patch, elapsed, field, reference, when, type Hit, type Scene } from '../latkit.js';
import type { Stage } from '../ui/stage.js';
import texas from './texas.json';

/** The control room's dark theme. */
const LOOK = {
  background: '#0a0a0a',
  ground: '#101214',
  border: '#8a919c',
  text: '#fafafa',
  hover: '#53a3f2',
  flow: '#5ad87e',
  warning: '#ffc000',
  critical: '#ff6200',
  tripped: '#ff1915',
} as const;

/** What each substation is, in the order its color index counts them. */
const KINDS = [
  { label: 'nuclear', color: '#a181ef', fuels: ['Nuclear Steam'] },
  {
    label: 'thermal',
    color: '#987a59',
    fuels: ['Gas Turbine', 'Gas Combined Cycle', 'Coal-fired Steam'],
  },
  { label: 'wind', color: '#00d1da', fuels: ['Wind'] },
  { label: 'solar', color: '#ffca29', fuels: ['Solar PV'] },
  { label: 'load', color: '#6b727e', fuels: ['Load'] },
] as const;
/** A branch's state, by color index: in service, near its rating, past it, or out. */
const STATES = [
  { label: 'in service', color: LOOK.text },
  { label: '90% of rating', color: LOOK.warning },
  { label: 'overloaded', color: LOOK.critical },
  { label: 'out', color: LOOK.tripped },
] as const;

/** Seconds between ticks of the simulation. */
const TICK = 0.5;
/** How far past its rating a branch runs before its protection trips it, and for how many ticks. */
const TRIP_AT = 1.15;
const TRIP_AFTER = 3;
/** Seconds a tripped branch stays out before it recloses. */
const OUT_FOR = 14;
/** Per unit reactance per kilometre of line. */
const REACTANCE = 0.0004;

type Substation = (typeof texas.substations)[number];

/** Each substation's kind, by index into `KINDS`. */
const kindOf = (s: Substation) =>
  KINDS.findIndex((k) => (k.fuels as readonly string[]).includes(s.category));

/**
 * The grid's state and its physics: plants dispatch to meet demand, a DC power flow sets every
 * branch's flow from the injections, protection trips branches held past their rating, and each
 * island balances on its own plants, its loads dark where it has none.
 */
class Grid {
  readonly n = texas.substations.length;
  readonly m = texas.branches.length;
  /** What each plant can make and each load asks for, MW. */
  readonly capacity = Float64Array.from(texas.substations, (s) =>
    s.units.reduce((a, b) => a + b, 0),
  );
  readonly load = Uint8Array.from(texas.substations, (s) => (s.category === 'Load' ? 1 : 0));
  readonly kind = Float32Array.from(texas.substations, kindOf);
  readonly rating = Float64Array.from(texas.branches, (b) => b.pmax);
  readonly #x: Float64Array;
  /** Each substation's output, or each load's demand served, as a share; MW injected. */
  readonly fill = new Float32Array(this.n);
  readonly injection = new Float64Array(this.n);
  /** Each branch's flow in MW, from its first end to its second; its loading; whether it is out. */
  readonly flow = new Float64Array(this.m);
  readonly loading = new Float64Array(this.m);
  readonly out = new Uint8Array(this.m);
  /** Ticks each branch has run past its trip setting, and when an out branch recloses. */
  readonly #over = new Uint8Array(this.m);
  readonly #reclose = new Float64Array(this.m);
  /** Plants out of service until a time. */
  readonly #plantOut = new Float64Array(this.n);
  /** Demand as a share of the loads' size, and the time. */
  demand = 0.78;
  t = 0;
  /** Branches tripped since the last restore, and loads dark now. */
  trips = 0;
  dark = 0;

  constructor() {
    const s = texas.substations;
    this.#x = Float64Array.from(texas.branches, (b) => {
      const [a, c] = [s[b.from]!, s[b.to]!];
      const km =
        Math.hypot((a.lon - c.lon) * Math.cos((a.lat * Math.PI) / 180), a.lat - c.lat) * 111;
      return Math.max(0.002, REACTANCE * km);
    });
    this.step(0);
  }

  /** Trips the branch loaded nearest its rating, as a fault would. */
  tripWorst(): void {
    let worst = -1;
    for (let j = 0; j < this.m; j++)
      if (!this.out[j] && (worst < 0 || this.loading[j]! > this.loading[worst]!)) worst = j;
    if (worst >= 0) this.#trip(worst);
    this.step(0);
  }

  /** Recloses every branch and plant. */
  restore(): void {
    this.out.fill(0);
    this.#over.fill(0);
    this.#plantOut.fill(0);
    this.trips = 0;
    this.step(0);
  }

  #trip(j: number): void {
    this.out[j] = 1;
    this.#reclose[j] = this.t + OUT_FOR;
    this.trips++;
  }

  /** Advances `dt` seconds: dispatch, flow, protection. */
  step(dt: number): void {
    this.t += dt;
    const { n, m, t } = this;
    for (let j = 0; j < m; j++)
      if (this.out[j] && t >= this.#reclose[j]! && this.#reclose[j]! > 0) this.out[j] = 0;
    // What each load asks for, swinging through the day, and what each plant could give.
    const want = new Float64Array(n);
    const can = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const wave = 0.08 * Math.sin(t * 0.07 + i * 1.3) + 0.04 * Math.sin(t * 0.31 + i * 0.7);
      if (this.load[i])
        want[i] = this.capacity[i]! * Math.min(1.4, Math.max(0, this.demand + wave));
      else if (t >= this.#plantOut[i]!) {
        // Wind and sun come and go; the rest follow dispatch.
        const k = this.kind[i]!;
        const weather =
          k === 2
            ? 0.55 + 0.4 * Math.sin(t * 0.11 + i)
            : k === 3
              ? 0.8 + 0.15 * Math.sin(t * 0.05 + i)
              : 1;
        can[i] = this.capacity[i]! * weather;
      }
    }
    // Islands of the branches in service, each balanced on its own plants.
    const island = this.#islands();
    this.dark = 0;
    for (const members of island) {
      const asked = members.reduce((sum, i) => sum + want[i]!, 0);
      const able = members.reduce((sum, i) => sum + can[i]!, 0);
      const served = able > 0 ? Math.min(1, able / Math.max(asked, 1e-9)) : 0;
      const dispatch = asked > 0 ? Math.min(1, (asked * served) / Math.max(able, 1e-9)) : 0;
      for (const i of members) {
        if (this.load[i]) {
          this.fill[i] = served;
          this.injection[i] = -want[i]! * served;
          if (served < 0.05 && want[i]! > 0) this.dark++;
        } else {
          this.fill[i] = this.capacity[i]! > 0 ? (can[i]! * dispatch) / this.capacity[i]! : 0;
          this.injection[i] = can[i]! * dispatch;
        }
      }
      this.#solve(members);
    }
    // Protection: a branch held past its trip setting trips; a plant now and then does too.
    for (let j = 0; j < m; j++) {
      this.loading[j] = this.out[j] ? 0 : Math.abs(this.flow[j]!) / this.rating[j]!;
      this.#over[j] = this.loading[j]! > TRIP_AT ? this.#over[j]! + 1 : 0;
      if (dt > 0 && this.#over[j]! >= TRIP_AFTER) this.#trip(j);
    }
    if (dt > 0 && Math.random() < 0.004) {
      const plants = [...Array(n).keys()].filter((i) => !this.load[i] && t >= this.#plantOut[i]!);
      const plant = plants[Math.floor(Math.random() * plants.length)];
      if (plant !== undefined) this.#plantOut[plant] = t + 20;
    }
  }

  /** Whether plant `i` is out of service. */
  tripped(i: number): boolean {
    return !this.load[i] && this.t < this.#plantOut[i]!;
  }

  /** Substations joined by branches in service, island by island. */
  #islands(): number[][] {
    const seen = new Uint8Array(this.n);
    const near: number[][] = Array.from({ length: this.n }, () => []);
    texas.branches.forEach((b, j) => {
      if (!this.out[j]) {
        near[b.from]!.push(b.to);
        near[b.to]!.push(b.from);
      }
    });
    const islands: number[][] = [];
    for (let start = 0; start < this.n; start++) {
      if (seen[start]) continue;
      const members = [start];
      seen[start] = 1;
      for (let k = 0; k < members.length; k++)
        for (const next of near[members[k]!]!) {
          if (seen[next]) continue;
          seen[next] = 1;
          members.push(next);
        }
      islands.push(members);
    }
    return islands;
  }

  /** The DC power flow of one island: angles from its injections, its first member the reference,
   * then each branch's flow. */
  #solve(members: number[]): void {
    const size = members.length - 1;
    const at = new Map(members.slice(1).map((bus, k) => [bus, k]));
    const b = Array.from({ length: size }, () => new Float64Array(size + 1));
    texas.branches.forEach((branch, j) => {
      if (this.out[j] || !(at.has(branch.from) || branch.from === members[0])) return;
      if (!(at.has(branch.to) || branch.to === members[0])) return;
      const y = 1 / this.#x[j]!;
      const [p, q] = [at.get(branch.from), at.get(branch.to)];
      if (p !== undefined) b[p]![p]! += y;
      if (q !== undefined) b[q]![q]! += y;
      if (p !== undefined && q !== undefined) {
        b[p]![q]! -= y;
        b[q]![p]! -= y;
      }
    });
    members.slice(1).forEach((bus, k) => (b[k]![size] = this.injection[bus]! / 100));
    // Gaussian elimination with partial pivoting; the island is small.
    for (let c = 0; c < size; c++) {
      let pivot = c;
      for (let r = c + 1; r < size; r++)
        if (Math.abs(b[r]![c]!) > Math.abs(b[pivot]![c]!)) pivot = r;
      [b[c], b[pivot]] = [b[pivot]!, b[c]!];
      const d = b[c]![c]! || 1e-12;
      for (let r = c + 1; r < size; r++) {
        const f = b[r]![c]! / d;
        if (f) for (let k = c; k <= size; k++) b[r]![k]! -= f * b[c]![k]!;
      }
    }
    const theta = new Float64Array(size);
    for (let r = size - 1; r >= 0; r--) {
      let sum = b[r]![size]!;
      for (let k = r + 1; k < size; k++) sum -= b[r]![k]! * theta[k]!;
      theta[r] = sum / (b[r]![r]! || 1e-12);
    }
    const angle = (bus: number) => (bus === members[0] ? 0 : theta[at.get(bus)!]!);
    texas.branches.forEach((branch, j) => {
      if (at.has(branch.from) || branch.from === members[0])
        this.flow[j] = this.out[j]
          ? 0
          : ((angle(branch.from) - angle(branch.to)) * 100) / this.#x[j]!;
    });
  }

  /** The grid's state as a patch of the `grid` dataset's changing fields. */
  patch(): Patch {
    const kind = Float32Array.from(this.kind, (k, i) =>
      this.tripped(i) || (this.load[i] && this.fill[i]! < 0.05) ? KINDS.length : k,
    );
    const state = Float32Array.from(this.loading, (l, j) =>
      this.out[j] ? 3 : l > 1 ? 2 : l > 0.9 ? 1 : 0,
    );
    return new Patch()
      .set('Substation', this.n, {
        fill: this.fill,
        kind,
        alarm: Uint8Array.from(kind, (k) => (k === KINDS.length ? 1 : 0)),
        mw: Float64Array.from(this.injection, Math.abs),
      })
      .set('Branch', this.m, {
        state,
        out: this.out,
        alarm: Uint8Array.from(state, (s) => (s >= 2 ? 1 : 0)),
        flow: Float64Array.from(this.flow, (f, j) =>
          this.out[j] ? 0 : Math.max(-1, Math.min(1, f / this.rating[j]!)),
        ),
        mw: Float64Array.from(this.flow, Math.abs),
        loading: Float64Array.from(this.loading, (l) => l * 100),
      });
  }
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
  data = data.apply(grid.patch());
  const border = new Data('state').apply(
    new Patch().set('Border', 1, {
      geometry: [[...texas.border, texas.border[0]!] as [number, number][]],
    }),
  );

  const state = { comets: true, labels: true, playing: true };
  /** What trips pulses: red to dark red and back, twice a second. */
  const pulse = elapsed()
    .mul(4 * Math.PI)
    .sin()
    .colormap({ kind: 'sequential', colors: ['#5c0805', LOOK.tripped] })
    .domain(-1, 1);
  const kinds = field('kind')
    .colormap({ kind: 'categorical', colors: [...KINDS.map((k) => k.color), LOOK.tripped] })
    .domain(0, KINDS.length);
  /** A substation mark: plants as round gauges, loads as square ones, in one table. */
  const substations = (name: string, load: number, shape: 'ellipse' | 'rounded') => ({
    vertices: {
      of: ['grid', 'Substation'] as [string, string],
      name,
      position: ['lon', 'lat'] as [string, string],
      visible: field('load').eq(load),
      // Both marks size every row alike, so branches stop at the outline that shows.
      radius: when(field('load').eq(1)).then(9).otherwise(11),
      marker: { gauge: { fill: field('fill'), shape } },
      color: kinds,
      status: when(field('alarm').gt(0.5)).then(pulse).otherwise('#00000000'),
      ...(state.labels ? { label: { text: 'name', size: 13, priority: 'capacity' } } : {}),
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
      flow: LOOK.flow,
      flowSpacing: 26,
      font: 'Jura, sans-serif',
      halo: 3,
      glow: 6,
      laneBow: 0.1,
    },
    ease: 0.45,
    marks: [
      { lines: { of: ['state', 'Border'], width: 1.5, color: LOOK.border, pick: false } },
      {
        edges: {
          of: ['grid', 'Branch'],
          ends: ['from', 'to'],
          route: 'straight',
          width: 2.5,
          color: when(field('alarm').gt(0.5))
            .then(pulse)
            .otherwise(
              field('state')
                .colormap({ kind: 'categorical', colors: STATES.map((x) => x.color) })
                .domain(0, 3),
            ),
          dash: 'out',
          // Comets run with the flow, faster the nearer its rating.
          ...(state.comets ? { flow: field('flow').mul(70) } : {}),
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
  gridSection.series(KINDS.map(({ label, color }) => ({ label, color })));
  gridSection.series(STATES.map(({ label, color }) => ({ label, color })));

  // ── Layers ──
  const layers = stage.section('Layers');
  layers.toggle('Comets', 'c', state.comets, (on) => ((state.comets = on), restyle()));
  layers.toggle('Labels', 'l', state.labels, (on) => ((state.labels = on), restyle()));

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
  view.on('hover', (hit) => ((hovered = hit), inspect()));
  view.on('select', inspect);

  const meter = stage.meter(view);
  meter.note(() => `${grid.trips} trips`);

  /** Shows the grid as it stands. */
  function show(): void {
    data = data.apply(grid.patch());
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
