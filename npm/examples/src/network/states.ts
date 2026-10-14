/**
 * A grid's figures for each state it reaches, written into the states dataset as fields its areas
 * color by: buses, load, and generation counted where each bus stands, and where the grid was
 * simulated, how far its machines' speeds swing in each state, frame by frame.
 */
import { Patch, type Data, type Id } from 'latkit';
import type { Case } from './cases.js';

/** What each state's figures hold, and in what unit. */
export const STATE_FIELDS = {
  buses: { label: 'buses', unit: '' },
  load: { label: 'load', unit: ' MW' },
  generation: { label: 'generation', unit: ' MW' },
  swing: { label: 'largest speed swing', unit: ' mHz' },
} as const;
export type StateField = keyof typeof STATE_FIELDS;

export interface Joined {
  readonly data: Data;
  /** How many states the grid reaches. */
  readonly states: number;
  /** Each figure's largest value in any state. */
  readonly peaks: Readonly<Record<StateField, number>>;
}

type Ring = [number, number][];

interface State {
  readonly row: number;
  /** West, south, east, north. */
  readonly bounds: readonly [number, number, number, number];
  readonly rings: readonly Ring[];
}

/** Whether a point lies inside a state: crossing its rings an odd number of times, holes included. */
function inside(state: State, x: number, y: number): boolean {
  const [w, s, e, n] = state.bounds;
  if (x < w || x > e || y < s || y > n) return false;
  let crossings = 0;
  for (const ring of state.rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) crossings++;
    }
  return crossings % 2 === 1;
}

/** `states` with the grid's figures for every state it reaches. */
export function joinStates(states: Data, grid: Case): Joined {
  const { positions, simulation } = grid;
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  for (let b = 0; b < grid.buses; b++) {
    extent[0] = Math.min(extent[0]!, positions[b * 2]!);
    extent[1] = Math.min(extent[1]!, positions[b * 2 + 1]!);
    extent[2] = Math.max(extent[2]!, positions[b * 2]!);
    extent[3] = Math.max(extent[3]!, positions[b * 2 + 1]!);
  }
  const ids: Id[] = states.ids('polygons');
  const found: State[] = [];
  ids.forEach((id, row) => {
    const polygons = (states.get('polygons', id, 'geometry') ?? []) as Ring[][];
    const rings = polygons.flat();
    const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of rings)
      for (const [x, y] of ring) {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
    const meets =
      bounds[0] <= extent[2]! &&
      bounds[2] >= extent[0]! &&
      bounds[1] <= extent[3]! &&
      bounds[3] >= extent[1]!;
    if (meets) found.push({ row, bounds, rings });
  });
  // Each degree cell's states, so a bus tests only those near it.
  const cells = new Map<number, State[]>();
  const cell = (x: number, y: number) => Math.floor(x + 180) * 180 + Math.floor(y + 90);
  for (const state of found) {
    const [w, s, e, n] = state.bounds;
    for (let x = Math.floor(Math.max(w, extent[0]!)); x <= Math.min(e, extent[2]!); x++)
      for (let y = Math.floor(Math.max(s, extent[1]!)); y <= Math.min(n, extent[3]!); y++) {
        const key = cell(x, y);
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(state);
      }
  }
  const rows = ids.length;
  const of = new Int32Array(grid.buses).fill(-1);
  const buses = new Float32Array(rows).fill(Number.NaN);
  const load = new Float32Array(rows).fill(Number.NaN);
  const generation = new Float32Array(rows).fill(Number.NaN);
  const reached = new Set<number>();
  for (let b = 0; b < grid.buses; b++) {
    const x = positions[b * 2]!;
    const y = positions[b * 2 + 1]!;
    const state = cells.get(cell(x, y))?.find((candidate) => inside(candidate, x, y));
    if (!state) continue;
    const k = state.row;
    of[b] = k;
    if (!reached.has(k)) {
      reached.add(k);
      buses[k] = load[k] = generation[k] = 0;
    }
    buses[k]! += 1;
    load[k]! += grid.load[b]!;
    generation[k]! += grid.generation[b]!;
  }
  const peak = (values: Float32Array) => values.reduce((top, v) => (v > top ? v : top), 0);
  const patch = new Patch().set('polygons', ids as number[], { buses, load, generation });
  const peaks = { buses: peak(buses), load: peak(load), generation: peak(generation), swing: 0 };
  if (simulation) {
    // Each frame, the largest swing of a state's machines either way.
    const g = grid.machines;
    const swing = new Float32Array(rows);
    for (let f = 0; f < simulation.frames; f++) {
      swing.fill(Number.NaN);
      for (const k of reached) swing[k] = 0;
      for (let m = 0; m < g; m++) {
        const k = of[grid.machineBus[m]!]!;
        if (k < 0) continue;
        swing[k] = Math.max(swing[k]!, Math.abs(simulation.speeds[f * g + m]!));
      }
      peaks.swing = Math.max(peaks.swing, peak(swing));
      patch.append(f * simulation.dt, 'polygons', { swing });
    }
  }
  return { data: states.apply(patch), states: reached.size, peaks };
}
