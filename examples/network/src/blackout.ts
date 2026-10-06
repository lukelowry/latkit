/**
 * The map panel of BlackoutUSA, drawn by a Latkit network: Texas's substations, branches, and
 * border in the game's dark theme. Each substation is a gauge of its output, a wedge in a plant's
 * ring and a bar in a load's; branches color by loading, dash once out, carry comets along their
 * flow, and draw apart when parallel. A stand-in for the game's simulation ticks twice a second,
 * and every change eases into place; trips pulse.
 */
import './blackout.css';
import { createColormap, createGpu, parseColor, pulse, type Marker, type RGBA } from '@latkit/gpu';
import {
  createData,
  type Column,
  type Data,
  type Index,
  type ListColumn,
  type Schema,
  type TextColumn,
} from '@latkit/model';
import { createNetwork, type NetworkConfig } from '@latkit/network';
import texas from './blackout-texas.json';

/** BlackoutUSA's dark theme, as its map panel reads it. */
const THEME = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  nuclear: '#a181ef',
  thermal: '#987a59',
  wind: '#00d1da',
  solar: '#ffca29',
  load: '#6b727e',
  flow: '#5ad87e',
  hover: '#53a3f2',
  warning: '#ffc000',
  critical: '#ff6200',
  tripped: '#ff1915',
};
const rgba = (css: string): RGBA => parseColor(css)!;
/** Each substation's category, as the game colors it: nuclear, thermal, wind, solar, or load. */
const CATEGORY: Readonly<Record<string, number>> = {
  'Nuclear Steam': 0,
  'Gas Turbine': 1,
  'Gas Combined Cycle': 1,
  'Coal-fired Steam': 1,
  Wind: 2,
  'Solar PV': 3,
  Load: 4,
};
/** A substation's color by category, and red once it trips. */
const fuels = createColormap({
  kind: 'categorical',
  colors: [THEME.nuclear, THEME.thermal, THEME.wind, THEME.solar, THEME.load, THEME.tripped].map(
    rgba,
  ),
});
/** A branch's state: in service, past its rating, far past it, or tripped. */
const states = createColormap({
  kind: 'categorical',
  colors: [THEME.foreground, THEME.warning, THEME.critical, THEME.tripped].map(rgba),
});
/**
 * A substation: the shared gauge, round for a plant and a rounded square for a load. Its fill
 * eases with each tick; whether it is a load never does.
 */
const substation: Marker = {
  inputs: { fill: 'fill', load: 'load' },
  steps: ['load'],
  wgsl: `fn marker(f: MarkerFragment) -> MarkerColor {
  return gaugeMarker(f, select(SHAPE_ELLIPSE, SHAPE_ROUNDED, f.load > 0.5), f.fill, 2.0, 1.5);
}`,
};

const subs = texas.substations,
  branches = texas.branches,
  n = subs.length,
  m = branches.length;
const index = (type: string): Index => ({ source: 'blackout-texas', type, version: '1' });
const rows = (count: number) => ({ kind: 'range', offset: 0, count }) as const;
const numbers = (values: Float32Array | Float64Array): Column => ({
  kind: 'numeric',
  offset: 0,
  length: values.length,
  values,
});
const reference = (values: number[]): Column => ({
  kind: 'reference',
  index: index('Substation'),
  offset: 0,
  length: values.length,
  values: Uint32Array.from(values),
});
function text(values: readonly string[]): TextColumn {
  const encoded = values.map((value) => new TextEncoder().encode(value)),
    offsets = new Int32Array(values.length + 1);
  encoded.forEach((bytes, i) => (offsets[i + 1] = offsets[i]! + bytes.length));
  const bytes = new Uint8Array(offsets[values.length]!);
  encoded.forEach((value, i) => bytes.set(value, offsets[i]!));
  return { kind: 'text', offset: 0, length: values.length, offsets, bytes };
}
const schema: Schema = {
  types: {
    Substation: {
      fields: {
        location: { type: { kind: 'vector', items: 'float64', size: 2 }, geographic: true },
        name: { type: 'text' },
        radius: { type: 'float32' },
        load: { type: 'float32' },
        color: { type: 'float32' },
        fill: { type: 'float32' },
        alarm: { type: 'float32' },
      },
    },
    Branch: {
      fields: {
        from: { type: { kind: 'reference', to: 'Substation' } },
        to: { type: { kind: 'reference', to: 'Substation' } },
        state: { type: 'float32' },
        out: { type: 'float32' },
        flow: { type: 'float32' },
        alarm: { type: 'float32' },
      },
    },
    Border: {
      fields: {
        points: {
          type: { kind: 'list', items: { kind: 'vector', items: 'float64', size: 2 } },
          geographic: true,
        },
      },
    },
  },
};
// What never changes: places, names, wiring, and the border.
const location = Float64Array.from(subs.flatMap((s) => [s.lon, s.lat])),
  isLoad = Float32Array.from(subs, (s) => (s.category === 'Load' ? 1 : 0)),
  category = Float32Array.from(subs, (s) => CATEGORY[s.category] ?? 4),
  fixed = {
    location: {
      kind: 'vector',
      size: 2,
      offset: 0,
      length: n,
      values: { kind: 'numeric', offset: 0, length: n * 2, values: location },
    } satisfies Column,
    name: text(subs.map((s) => s.name)),
    radius: numbers(Float32Array.from(isLoad, (load) => (load ? 9 : 11))),
    load: numbers(isLoad),
  },
  wires = {
    from: reference(branches.map((b) => b.from)),
    to: reference(branches.map((b) => b.to)),
  },
  border: ListColumn = {
    kind: 'list',
    offset: 0,
    length: 1,
    offsets: Int32Array.of(0, texas.border.length + 1),
    values: {
      kind: 'vector',
      size: 2,
      offset: 0,
      length: texas.border.length + 1,
      values: {
        kind: 'numeric',
        offset: 0,
        length: (texas.border.length + 1) * 2,
        values: Float64Array.from([...texas.border, texas.border[0]!].flat()),
      },
    },
  };
/** The one plant that trips now and then, and the branches out of service or tripping. */
const TRIPPING = subs.findIndex((s) => s.category === 'Gas Turbine'),
  DISCONNECTED = 5,
  TRIPPED_BRANCH = 17,
  STRAINED = new Set([2, 23, 41]);
/**
 * The network as it stands at `t` seconds: a stand-in for the game's simulation, with output
 * swinging, loads shedding units, flows reversing, a few branches straining past their rating, and
 * one plant and one branch tripping on a cycle.
 */
function snapshot(t: number): Data {
  const fill = new Float32Array(n),
    color = new Float32Array(n),
    alarm = new Float32Array(n),
    state = new Float32Array(m),
    out = new Float32Array(m),
    flow = new Float32Array(m),
    strain = new Float32Array(m);
  subs.forEach((s, i) => {
    const tripped = i === TRIPPING && t % 20 > 14;
    if (s.category === 'Load') {
      // Units in service, as a load's bar shows them.
      const total = s.units.reduce((sum, p) => sum + p, 0),
        live = s.units.reduce(
          (sum, p, u) => sum + (Math.sin(t * 0.21 + i * 1.3 + u * 2.1) > 0.9 ? 0 : p),
          0,
        );
      fill[i] = total > 0 ? live / total : 0;
    } else fill[i] = tripped ? 0 : 0.5 + 0.42 * Math.sin(t * 0.35 + i * 1.7);
    color[i] = tripped ? 5 : category[i]!;
    alarm[i] = tripped ? 1 : 0;
  });
  branches.forEach((b, j) => {
    const swing = Math.sin(t * (0.12 + (j % 7) * 0.02) + j * 0.9),
      ratio = Math.abs(swing) * (STRAINED.has(j) ? 1.35 : 0.85),
      trip = j === TRIPPED_BRANCH && t % 16 > 11,
      off = j === DISCONNECTED;
    state[j] = trip ? 3 : off ? 0 : ratio > 1.2 ? 2 : ratio > 1 ? 1 : 0;
    out[j] = trip || off ? 1 : 0;
    flow[j] = trip || off ? 0 : swing;
    strain[j] = trip || state[j]! >= 2 ? 1 : 0;
  });
  return createData(schema, [
    {
      kind: 'rows',
      index: index('Substation'),
      rows: rows(n),
      columns: { ...fixed, color: numbers(color), fill: numbers(fill), alarm: numbers(alarm) },
    },
    {
      kind: 'rows',
      index: index('Branch'),
      rows: rows(m),
      columns: {
        ...wires,
        state: numbers(state),
        out: numbers(out),
        flow: numbers(flow),
        alarm: numbers(strain),
      },
    },
    { kind: 'rows', index: index('Border'), rows: rows(1), columns: { points: border } },
  ]);
}

const canvas = document.querySelector<HTMLCanvasElement>('#map')!,
  error = document.querySelector<HTMLElement>('#error')!;
/** The game's first view: the case's bounds at 90% of the panel, centered, a degree each way alike. */
function framing() {
  const { xMin, xMax, yMin, yMax } = texas.bounds,
    scale = Math.min(
      (Math.max(1, canvas.clientWidth) * 0.9) / (xMax - xMin),
      (Math.max(1, canvas.clientHeight) * 0.9) / (yMax - yMin),
    );
  return {
    camera: { center: [(xMin + xMax) / 2, (yMin + yMax) / 2] as const, scale, fit: false },
    // Comets sit 0.4 degrees apart and move up to 0.6 degrees a second, as the game's dots do.
    spacing: 0.4 * scale,
    speed: 0.6 * scale,
  };
}
const flowPx = (speed: number) =>
  ({ field: 'flow', domain: [-1, 1], range: [-speed, speed] }) as const;
function config(source: Data): NetworkConfig {
  const { camera, spacing, speed } = framing();
  return {
    canvas,
    source,
    camera,
    background: rgba(THEME.background),
    surfaceColor: rgba(THEME.background),
    textColor: rgba(THEME.foreground),
    hoverColor: rgba(THEME.hover),
    selectedColor: rgba(THEME.hover),
    animationMs: 450,
    // Trips and branches far past their rating pulse red.
    shade: pulse({ periodMs: 900, strength: 0.6, color: [1, 0.1, 0.08] }),
    shadows: true,
    labelHaloPx: 3,
    edgeWidthPx: 2.5,
    edgeSpacingPx: 8,
    dashPeriodPx: 10,
    flowColor: rgba(THEME.flow),
    flowSpacingPx: spacing,
    vertices: {
      Substation: {
        x: 'location',
        y: { field: 'location', component: 1 },
        radiusPx: { field: 'radius', domain: [9, 11], range: [9, 11] },
        color: { field: 'color', domain: [0, 5], colormap: fuels },
        marker: substation,
        shade: 'alarm',
        labels: {
          field: 'name',
          font: { family: 'Jura' },
          fontSizePx: 14,
          color: rgba(THEME.foreground),
          maxCount: n,
        },
      },
    },
    edges: {
      Branch: {
        ends: ['from', 'to'],
        color: { field: 'state', domain: [0, 3], colormap: states },
        dash: 'out',
        flowPx: flowPx(speed),
        shade: 'alarm',
      },
    },
    paths: { Border: { points: 'points', widthPx: 1.5, color: rgba(THEME.foreground) } },
  };
}

try {
  // Labels set in Jura only once it has loaded.
  await document.fonts.load('14px Jura');
  const gpu = await createGpu(),
    started = performance.now(),
    network = createNetwork(gpu, config(snapshot(0)));
  network.on('error', (e) => {
    error.hidden = false;
    error.textContent = String((e as { message?: string }).message ?? e);
  });
  // The game's simulation ticks twice a second; each tick eases in, and comets move every frame.
  const tick = setInterval(
    () =>
      network.set({ source: snapshot((performance.now() - started) / 1000) }, { animate: true }),
    500,
  );
  new ResizeObserver(() => {
    const { camera, spacing, speed } = framing();
    network.set({ camera, flowSpacingPx: spacing, edges: { Branch: { flowPx: flowPx(speed) } } });
  }).observe(canvas);
  Object.assign(globalThis, {
    blackout: { gpu, network, snapshot, stop: () => clearInterval(tick) },
  });
} catch (failure) {
  error.hidden = false;
  error.textContent = failure instanceof Error ? failure.message : String(failure);
}
