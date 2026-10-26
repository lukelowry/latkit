/**
 * A model of the grid a control room watches. Plants dispatch to meet demand, a DC power flow sets
 * every branch's flow, protection trips overloaded branches, and each island balances on its own.
 */
import texas from './texas.json';

/** The kinds of substation, in color index order. `fuels` lists the categories of each kind. */
export const KINDS = [
  { label: 'nuclear', color: '#a181ef', fuels: ['Nuclear Steam'] },
  {
    label: 'thermal',
    color: '#c08a52',
    fuels: ['Gas Turbine', 'Gas Combined Cycle', 'Coal-fired Steam'],
  },
  { label: 'wind', color: '#00d1da', fuels: ['Wind'] },
  { label: 'solar', color: '#ffca29', fuels: ['Solar PV'] },
  { label: 'load', color: '#8a93a0', fuels: ['Load'] },
] as const;
/** Protection trips a branch loaded over `TRIP_AT` times its rating for `TRIP_AFTER` ticks in a
 * row. */
export const TRIP_AT = 1.15;
export const TRIP_AFTER = 3;
/** Seconds a tripped branch stays out before it recloses. */
export const OUT_FOR = 14;
/** Per unit reactance per kilometre of line. */
export const REACTANCE = 0.0004;

type Substation = (typeof texas.substations)[number];

/** A substation's kind, as an index into `KINDS`. */
const kindOf = (s: Substation) =>
  KINDS.findIndex((k) => (k.fuels as readonly string[]).includes(s.category));

/**
 * The grid's state and physics. Plants dispatch to meet demand, and a DC power flow sets every
 * branch's flow from the injections. Protection trips branches that stay over their rating. Each
 * island balances on its own plants, and its loads go dark if it has none.
 */
export class Grid {
  readonly n = texas.substations.length;
  readonly m = texas.branches.length;
  /** Each plant's capacity, or each load's size, in MW. */
  readonly capacity = Float64Array.from(texas.substations, (s) =>
    s.units.reduce((a, b) => a + b, 0),
  );
  readonly load = Uint8Array.from(texas.substations, (s) => (s.category === 'Load' ? 1 : 0));
  readonly kind = Float32Array.from(texas.substations, kindOf);
  readonly rating = Float64Array.from(texas.branches, (b) => b.pmax);
  readonly #x: Float64Array;
  /** Each plant's output as a share of its capacity, or each load's share of demand served.
   * `injection` holds the MW each substation injects. */
  readonly fill = new Float32Array(this.n);
  readonly injection = new Float64Array(this.n);
  /** Each branch's flow in MW from its `from` end to its `to` end, its loading as a share of its
   * rating, and whether it is out. */
  readonly flow = new Float64Array(this.m);
  readonly loading = new Float64Array(this.m);
  readonly out = new Uint8Array(this.m);
  /** Consecutive ticks each branch has been over its trip setting, and when an out branch
   * recloses. */
  readonly #over = new Uint8Array(this.m);
  readonly #reclose = new Float64Array(this.m);
  /** For each plant, the time until which it is out of service. */
  readonly #plantOut = new Float64Array(this.n);
  /** Demand as a share of the loads' size, and the simulated time in seconds. */
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

  /** Trips the most heavily loaded branch in service, as a fault would. */
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

  /** Advances `dt` seconds, then dispatches, solves the flows, and runs protection. A `dt` of 0
   * solves again without tripping anything. */
  step(dt: number): void {
    this.t += dt;
    const { n, m, t } = this;
    for (let j = 0; j < m; j++)
      if (this.out[j] && t >= this.#reclose[j]! && this.#reclose[j]! > 0) this.out[j] = 0;
    // Each load's demand, which swings through the day, and each plant's available output.
    const want = new Float64Array(n);
    const can = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const wave = 0.08 * Math.sin(t * 0.07 + i * 1.3) + 0.04 * Math.sin(t * 0.31 + i * 0.7);
      if (this.load[i])
        want[i] = this.capacity[i]! * Math.min(1.4, Math.max(0, this.demand + wave));
      else if (t >= this.#plantOut[i]!) {
        // Wind and solar output vary with the weather. Other plants follow dispatch.
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
    // Split the grid into islands joined by branches in service, and balance each on its own
    // plants.
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
    // Protection trips a branch that stays over its trip setting. Now and then a plant trips too.
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

  /** Groups the substations into islands joined by branches in service. */
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

  /** Solves the DC power flow of one island. Bus angles come from the injections (per unit on a
   * 100 MVA base), with the first member as the reference bus. Branch flows follow from the
   * angles. */
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
    // Gaussian elimination with partial pivoting, which is fast enough for an island this small.
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
}
