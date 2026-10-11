/**
 * A grid's figures for each state it reaches, as values the map's areas join by id: buses, load,
 * and generation counted where each bus stands, and where the grid was simulated, how far its
 * machines' speeds swing in each state, frame by frame.
 */
import {
  appendData,
  bitAt,
  createData,
  read,
  rowCount,
  textAt,
  textColumn,
  type Column,
  type Data,
} from '@latkit/model';
import { numeric, rows } from '../shared/columns.js';
import type { GridCase } from './cases.js';

interface State {
  readonly id: string;
  /** West, south, east, north. */
  readonly bounds: readonly [number, number, number, number];
  /** Each ring's points: longitude, latitude, end to end. */
  readonly rings: readonly Float64Array[];
}
/** What each state's values hold, and in what unit. */
export const STATE_FIELDS = {
  buses: { label: 'buses', unit: '' },
  load: { label: 'load', unit: ' MW' },
  generation: { label: 'generation', unit: ' MW' },
  swing: { label: 'largest speed swing', unit: ' mHz' },
} as const;
export type StateField = keyof typeof STATE_FIELDS;
export interface StateValues {
  readonly data: Data;
  /** How many states the grid reaches. */
  readonly states: number;
  /** Each figure's largest value in any state. */
  readonly peaks: Readonly<Record<StateField, number>>;
}
const peak = (values: Float32Array) => values.reduce((top, value) => Math.max(top, value), 0);

/** Each state's id, bounds, and rings, where they meet `within`: west, south, east, north. */
async function statesOf(data: Data, type: string, within: readonly number[]): Promise<State[]> {
  const found: State[] = [];
  for await (const block of read(data, {
    kind: 'rows',
    from: type,
    select: ['rings'],
    ids: true,
  })) {
    if (block.kind !== 'rows') continue;
    const column = block.columns.rings as Column.List | undefined;
    if (!column) continue;
    const ringList = column.values as Column.List,
      points = (ringList.values as Column.Vector).values as Column.Numeric;
    for (let i = 0; i < rowCount(block.rows); i++) {
      if (!bitAt(column.validity, column.offset + i)) continue;
      const rings: Float64Array[] = [],
        bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (
        let r = column.offsets[column.offset + i]!;
        r < column.offsets[column.offset + i + 1]!;
        r++
      ) {
        const start = ringList.offsets[r]!,
          end = ringList.offsets[r + 1]!,
          ring = Float64Array.from(points.values.subarray(start * 2, end * 2));
        for (let p = 0; p < ring.length; p += 2) {
          bounds[0] = Math.min(bounds[0], ring[p]!);
          bounds[1] = Math.min(bounds[1], ring[p + 1]!);
          bounds[2] = Math.max(bounds[2], ring[p]!);
          bounds[3] = Math.max(bounds[3], ring[p + 1]!);
        }
        rings.push(ring);
      }
      if (
        bounds[0] > within[2]! ||
        bounds[2] < within[0]! ||
        bounds[1] > within[3]! ||
        bounds[3] < within[1]!
      )
        continue;
      found.push({ id: block.ids ? (textAt(block.ids, i) ?? '') : '', bounds, rings });
    }
  }
  return found;
}
/** Whether a point lies inside a state: crossing its rings an odd number of times, holes included. */
function inside(state: State, x: number, y: number): boolean {
  const [w, s, e, n] = state.bounds;
  if (x < w || x > e || y < s || y > n) return false;
  let crossings = 0;
  for (const ring of state.rings)
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i]!,
        yi = ring[i + 1]!,
        xj = ring[j]!,
        yj = ring[j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) crossings++;
    }
  return crossings % 2 === 1;
}

/** The grid's figures per state, as rows of the areas' type with the states' ids. */
export async function stateValues(
  states: Data,
  type: string,
  grid: GridCase,
): Promise<StateValues> {
  const { positions, simulation } = grid,
    extent = [Infinity, Infinity, -Infinity, -Infinity];
  for (let b = 0; b < grid.buses; b++) {
    extent[0] = Math.min(extent[0]!, positions[b * 2]!);
    extent[1] = Math.min(extent[1]!, positions[b * 2 + 1]!);
    extent[2] = Math.max(extent[2]!, positions[b * 2]!);
    extent[3] = Math.max(extent[3]!, positions[b * 2 + 1]!);
  }
  const found = await statesOf(states, type, extent);
  // Each degree cell's states, so a bus tests only those near it.
  const cells = new Map<number, State[]>(),
    cell = (x: number, y: number) => Math.floor(x + 180) * 180 + Math.floor(y + 90);
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
  const of = new Int32Array(grid.buses).fill(-1),
    order = new Map<State, number>();
  for (let b = 0; b < grid.buses; b++) {
    const x = positions[b * 2]!,
      y = positions[b * 2 + 1]!,
      state = cells.get(cell(x, y))?.find((candidate) => inside(candidate, x, y));
    if (!state) continue;
    let k = order.get(state);
    if (k === undefined) order.set(state, (k = order.size));
    of[b] = k;
  }
  const count = order.size,
    buses = new Float32Array(count),
    load = new Float32Array(count),
    generation = new Float32Array(count);
  for (let b = 0; b < grid.buses; b++) {
    const k = of[b]!;
    if (k < 0) continue;
    buses[k]!++;
    load[k]! += grid.load[b]!;
    generation[k]! += grid.generation[b]!;
  }
  const index = { source: `${grid.name}-states`, type, version: '1' },
    columns: Record<string, Column> = {
      buses: numeric(buses),
      load: numeric(load),
      generation: numeric(generation),
    };
  const data = createData(
    {
      ...(simulation ? { axis: { name: 'Time', unit: 's' } } : {}),
      types: {
        [type]: {
          fields: {
            buses: { type: 'float32' },
            load: { type: 'float32' },
            generation: { type: 'float32' },
            ...(simulation ? { swing: { type: 'float32', sampled: true } } : {}),
          },
        },
      },
    },
    [rows(index, count, columns, textColumn([...order.keys()].map((state) => state.id)))],
  );
  const peaks = { buses: peak(buses), load: peak(load), generation: peak(generation), swing: 0 };
  if (!simulation) return { data, states: count, peaks };
  // Each frame, the largest swing of a state's machines either way.
  const g = grid.machines,
    swing = new Float32Array(simulation.frames * count);
  for (let f = 0; f < simulation.frames; f++)
    for (let m = 0; m < g; m++) {
      const k = of[grid.machineBus[m]!]!;
      if (k < 0) continue;
      const at = f * count + k;
      swing[at] = Math.max(swing[at]!, Math.abs(simulation.speeds[f * g + m]!));
    }
  return {
    data: appendData(data, [
      {
        kind: 'samples',
        index,
        rows: { kind: 'range', offset: 0, count },
        firstFrame: 0,
        coordinates: Float64Array.from({ length: simulation.frames }, (_, f) => f * simulation.dt),
        columns: { swing: { ...numeric(swing), frameStride: count, rowStride: 1 } },
      },
    ]),
    states: count,
    peaks: { ...peaks, swing: peak(swing) },
  };
}
