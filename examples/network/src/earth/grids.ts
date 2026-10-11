/**
 * The grids the page draws: synthetic cases of real regions, two of them simulated through a fault,
 * and lattices past any of them in size. Each draws its buses, lines, and machines as the panel
 * says.
 */
import {
  colormaps,
  createColormap,
  parseColor,
  shape,
  type Colormap,
  type RGBA,
} from '@latkit/gpu';
import { createData, type Data } from '@latkit/model';
import type { Network } from '@latkit/network';
import { LEVELS, loadCase, type GridCase } from './cases.js';
import { lattice } from './lattice.js';
import type { Progress } from './download.js';

export interface Grid {
  readonly data: Data;
  readonly buses: number;
  readonly lines: number;
  readonly summary: string;
  /** A case: what states join, and what it simulated. */
  readonly case?: GridCase;
  /** The largest load, generation, and machine output among its rows, in MW. */
  readonly peaks: { readonly load: number; readonly generation: number; readonly power: number };
}
export interface GridChoice {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  load(signal: AbortSignal, progress: Progress): Promise<Grid>;
}
/** What buses can color by. */
export type BusColor = 'level' | 'load' | 'generation';
export interface Look {
  readonly color: BusColor;
  readonly machines: boolean;
  readonly labels: boolean;
}

/** Each voltage level's color, from below 100 kV to 765 kV. */
const LEVEL_COLORS = ['#56657a', '#2fa49b', '#7fc97f', '#e6c84f', '#f08a3c', '#e5486f'];
export const VOLTAGE = createColormap({
  kind: 'categorical',
  label: 'Voltage',
  colors: LEVEL_COLORS.map((css) => parseColor(css)!),
});
export const VOLTAGE_LEGEND = LEVELS.map((label, i) => ({ label, color: LEVEL_COLORS[i]! }));
/** How each colored field reads. */
export const BUS_COLORS: Readonly<
  Record<BusColor, { readonly label: string; readonly colormap: Colormap }>
> = {
  level: { label: 'voltage', colormap: VOLTAGE },
  load: { label: 'load', colormap: colormaps.mako },
  generation: { label: 'generation', colormap: colormaps.amber },
};
export const SPEED = colormaps.coolwarm;
const FAULT: RGBA = [1, 0.22, 0.16, 1];

const peak = (values: Float32Array) => values.reduce((top, value) => Math.max(top, value), 0);
function synthetic(id: string, label: string): GridChoice {
  return {
    id,
    label,
    group: 'Synthetic grids',
    async load(signal, progress) {
      const started = performance.now(),
        found = await loadCase(id, signal, progress);
      return {
        data: found.data,
        buses: found.buses,
        lines: found.lines,
        case: found,
        peaks: {
          load: peak(found.load),
          generation: peak(found.generation),
          power: peak(found.machinePower),
        },
        summary: `${(found.bytes / 1e6).toFixed(2)} MB in ${(performance.now() - started).toFixed(0)} ms`,
      };
    },
  };
}
function stress(id: string, label: string): GridChoice {
  return {
    id,
    label,
    group: 'Stress tests',
    load() {
      const started = performance.now(),
        built = lattice(id);
      return Promise.resolve({
        ...built,
        peaks: { load: 1, generation: 0, power: 0 },
        summary: `built in ${(performance.now() - started).toFixed(0)} ms`,
      });
    },
  };
}
export const GRIDS: readonly GridChoice[] = [
  synthetic('wecc240', 'WECC 240-bus, simulated fault'),
  synthetic('activsg2000', 'ACTIVSg2000, Texas'),
  synthetic('activsg10k', 'ACTIVSg10k, western US, simulated fault'),
  synthetic('activsg25k', 'ACTIVSg25k, US Northeast'),
  synthetic('activsg70k', 'ACTIVSg70k, eastern US'),
  stress('lattice-100k', 'Lattice, 100,000 buses'),
  stress('lattice-1m', 'Lattice, 1,000,000 buses'),
  {
    id: 'none',
    label: 'None: the map alone',
    group: 'Stress tests',
    load() {
      return Promise.resolve({
        data: createData({ types: { Bus: { fields: {} } } }, []),
        buses: 0,
        lines: 0,
        peaks: { load: 0, generation: 0, power: 0 },
        summary: 'nothing to draw',
      });
    },
  },
];

const POSITION = { x: 'position', y: { field: 'position', component: 1 } } as const;
/** What the network draws for a grid: its types, as the look says. */
export function gridOptions(
  grid: Grid,
  look: Look,
): {
  vertices: Record<string, Network.VertexOptions>;
  edges: Record<string, Network.EdgeOptions>;
  edgeWidthPx: number;
} {
  const big = grid.buses > 20000;
  if (!grid.case) {
    if (!grid.buses) return { vertices: {}, edges: {}, edgeWidthPx: 1 };
    return {
      vertices: {
        Bus: {
          ...POSITION,
          color: { field: 'load', domain: [0, 1], colormap: colormaps.viridis },
          radiusPx: 1.2,
        },
      },
      edges: { Line: { ends: ['from', 'to'] } },
      edgeWidthPx: 0.6,
    };
  }
  const { simulation } = grid.case,
    color =
      look.color === 'level'
        ? { field: 'level', domain: [0, 5] as const, colormap: VOLTAGE }
        : {
            field: look.color,
            domain: [0, Math.max(1, grid.peaks[look.color])] as const,
            colormap: BUS_COLORS[look.color].colormap,
          };
  const vertices: Record<string, Network.VertexOptions> = {
    Bus: {
      ...POSITION,
      color,
      radiusPx: big ? 1.4 : grid.buses > 5000 ? 2 : 3,
      labels: look.labels ? { field: 'name', maxCount: 40, repeatSpacingPx: 60 } : null,
    },
  };
  if (look.machines && grid.case.machines)
    vertices.Machine = {
      ...POSITION,
      marker: shape('diamond'),
      color: simulation
        ? { field: 'speed', domain: [-simulation.largest, simulation.largest], colormap: SPEED }
        : [0.92, 0.94, 0.97, 1],
      radiusPx: {
        field: 'power',
        domain: [0, Math.max(1, grid.peaks.power)],
        range: big ? [2, 5] : [3, 8],
      },
    };
  if (simulation?.fault)
    vertices.Fault = { ...POSITION, color: FAULT, radiusPx: 9, marker: shape('rounded') };
  return {
    vertices,
    edges: {
      Line: {
        ends: ['from', 'to'],
        color: { field: 'level', domain: [0, 5], colormap: VOLTAGE },
        widthPx: { field: 'level', domain: [0, 5], range: big ? [0.5, 1.8] : [0.8, 2.8] },
        dash: 'transformer',
      },
    },
    edgeWidthPx: 1,
  };
}
