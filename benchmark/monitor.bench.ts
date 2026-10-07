import { describe } from 'vitest';
import { appendData, type Data, type Domain, type SampleBatch } from '@latkit/model';
import { pulse, type ColormapName, type RGBA } from '@latkit/gpu';
import { createMonitor, type Monitor, type MonitorConfig } from '@latkit/monitor';
import { busIndex, counters, draw, frames, gpu, grid, suite, voltages } from './harness.ts';

/** A frame of voltages swinging wider than any before, as a disturbance grows: every frame is a new extreme. */
function swelling(buses: number, frame: number): SampleBatch {
  const batch = voltages(buses, frame),
    swing = 0.05 + frame * 0.01,
    values = Float32Array.from(
      { length: buses },
      (_, i) => 1 + Math.sin(i * 0.01 + frame * 0.2) * swing,
    );
  return {
    ...batch,
    columns: { voltage: { ...batch.columns.voltage, values } },
  };
}

/** A trace per row: monitors scale with the rows they draw. */
describe.each([100, 1_000, 10_000])('monitor %i rows', async (rows) => {
  const device = await gpu();
  let data = grid(rows);
  // A fixed window with room for the stream, as a run that declares its domain uses.
  const config: MonitorConfig = {
    source: data,
    traces: { voltage: { from: 'Bus', y: 'voltage' } },
    camera: { x: [0, frames * 4] },
  };
  const view = createMonitor(device, config);
  await draw(device, view, 0, 'complete');
  const measure = suite(`monitor ${rows} rows`, rows, () => counters(device), 12);
  measure('first frame', async () => {
    const fresh = createMonitor(device, config);
    await draw(device, fresh, 0, 'complete');
    fresh.destroy();
  });
  measure('cached frame', () => draw(device, view));
  // Moving the playhead never reads history again.
  measure('playhead', (i) => draw(device, view, i % frames));
  // A quarter in: inside the recorded frames of the wide window.
  measure('pick', () => view.pick([280, 360], { radiusPx: 24 }));
  // Each new frame draws alone, joined to the last.
  measure('stream frame', async (i) => {
    data = appendData(data, [voltages(rows, frames + i)]);
    view.set({ source: data });
    await draw(device, view, frames + i, 'complete');
  });
  // A new window redraws history behind the shown image.
  measure('change window', async (i) => {
    view.set({ camera: { x: [0, frames * 4 + 1 + (i % 2)] } });
    await draw(device, view, 0, 'complete');
  });
  // Each new frame a new extreme, with the values fitted: the fit grows, history stands.
  let swollen = grid(rows);
  const growing = createMonitor(device, { ...config, source: swollen });
  await draw(device, growing, 0, 'complete');
  measure('stream frame, growing extremes', async (i) => {
    swollen = appendData(swollen, [swelling(rows, frames + i)]);
    growing.set({ source: swollen });
    await draw(device, growing, frames + i, 'complete');
  });
});

/** How a scenario's traces look this iteration: mapped traces' domain and colormap, fixed traces' color. */
interface Look {
  readonly domain: Domain;
  readonly colormap: ColormapName;
  readonly color: RGBA;
}
const lookAt = (i: number): Look => ({
  domain: [0.95 - i * 1e-3, 1.05 + i * 1e-3],
  colormap: i % 2 ? 'magma' : 'viridis',
  color: [0.2 + (i % 5) * 0.15, 0.6, 0.9, 0.8],
});
/** The `i`th of `n` equal row ranges. */
const part = (rows: number, i: number, n: number) => {
  const offset = Math.floor((rows * i) / n);
  return { kind: 'range' as const, offset, count: Math.floor((rows * (i + 1)) / n) - offset };
};
const fixed = (color: RGBA, rows?: ReturnType<typeof part>) => ({
  from: 'Bus',
  y: 'voltage',
  color,
  ...(rows && { rows }),
});
const mapped = (look: Look, rows?: ReturnType<typeof part>, shift = 0) => ({
  from: 'Bus',
  y: 'voltage',
  color: {
    field: 'voltage',
    domain: [look.domain[0] - shift, look.domain[1] + shift] as const,
    colormap: look.colormap,
  },
  ...(rows && { rows }),
});
/**
 * Trace setups, each over every row: one trace, or four drawing a quarter each, so every setup draws
 * the same segments. Fixed traces take a color; mapped traces color by what they plot.
 */
const SCENARIOS: Record<
  string,
  { traces(rows: number, look: Look): MonitorConfig['traces']; style?: Partial<MonitorConfig> }
> = {
  'one fixed trace': { traces: (_, look) => ({ a: fixed(look.color) }) },
  'one mapped trace': { traces: (_, look) => ({ a: mapped(look) }) },
  'one trace colored by another field': {
    traces: (_, look) => ({
      a: {
        from: 'Bus',
        y: 'voltage',
        color: {
          field: 'load',
          domain: [look.domain[0] - 0.95, look.domain[1] - 0.05] as const,
          colormap: look.colormap,
        },
      },
    }),
  },
  'one following trace': {
    traces: (_, look) => ({
      a: { from: 'Bus', y: 'voltage', color: { field: 'voltage', colormap: look.colormap } },
    }),
  },
  'four fixed traces': {
    traces: (rows, look) =>
      Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((name, i) => [
          name,
          fixed([look.color[0], look.color[1], i / 4, 0.8], part(rows, i, 4)),
        ]),
      ),
  },
  'four mapped traces, one look': {
    traces: (rows, look) =>
      Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((name, i) => [name, mapped(look, part(rows, i, 4))]),
      ),
  },
  'four mapped traces, four looks': {
    traces: (rows, look) =>
      Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((name, i) => [name, mapped(look, part(rows, i, 4), i * 0.01)]),
      ),
  },
  // Past the looks an image keeps apart, the rest bake into its color layer.
  'eight traces colored by another field, eight looks': {
    traces: (rows, look) =>
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          't' + i,
          {
            from: 'Bus',
            y: 'voltage',
            rows: part(rows, i, 8),
            color: {
              field: 'load',
              domain: [look.domain[0] - 0.95 - i * 0.01, look.domain[1] - 0.05] as const,
              colormap: look.colormap,
            },
          },
        ]),
      ),
  },
  'two fixed, two mapped traces': {
    traces: (rows, look) => ({
      a: fixed(look.color, part(rows, 0, 4)),
      b: mapped(look, part(rows, 1, 4)),
      c: fixed([0.9, 0.4, 0.2, 0.8], part(rows, 2, 4)),
      d: mapped(look, part(rows, 3, 4)),
    }),
  },
  'one mapped trace, msaa': { traces: (_, look) => ({ a: mapped(look) }), style: { msaa: 4 } },
};

/** Each setup through every change an application makes, at two sizes: what each costs. */
describe.each(
  Object.keys(SCENARIOS).flatMap((scenario) =>
    [1_000, 10_000].map((rows) => [scenario, rows] as const),
  ),
)('monitor %s %i rows', async (scenario, rows) => {
  const device = await gpu(),
    { traces, style } = SCENARIOS[scenario],
    configOf = (source: Data, i = 0): MonitorConfig => ({
      source,
      traces: traces(rows, lookAt(i)),
      camera: { x: [0, frames * 4] },
      // Large enough for every setup; the memory each holds is reported apart.
      limits: { historyBytes: 1024 ** 3 },
      ...style,
    });
  /** A monitor drawn whole, before anything is measured. */
  const ready = async (extra: Partial<MonitorConfig> = {}) => {
    const view = createMonitor(device, { ...configOf(grid(rows)), ...extra });
    await draw(device, view, 0, 'complete');
    return view;
  };
  const measure = suite(`monitor ${scenario} ${rows} rows`, rows, () => counters(device), 12);
  const at = (view: Monitor, i: number, set: Parameters<Monitor['set']>[0]) => {
    view.set(set);
    return draw(device, view, i % frames, 'complete');
  };

  measure('first frame', async () => {
    const fresh = createMonitor(device, configOf(grid(rows)));
    await draw(device, fresh, 0, 'complete');
    fresh.destroy();
  });
  const cached = await ready();
  measure('cached frame', () => draw(device, cached));
  measure('playhead', (i) => draw(device, cached, i % frames));
  measure('pick', () => cached.pick([280, 360], { radiusPx: 24 }));
  // The pointer rests while the playhead moves: what was drawn stands, and so does its answer.
  measure('pick during playback', async (i) => {
    await draw(device, cached, i % frames);
    return cached.pick([280, 360], { radiusPx: 24 });
  });

  // A live run: each new frame draws alone, joined to the last.
  let streamed = grid(rows);
  const stream = await ready();
  measure('stream frame', async (i) => {
    streamed = appendData(streamed, [voltages(rows, frames + i)]);
    stream.set({ source: streamed });
    await draw(device, stream, frames + i, 'complete');
  });
  // As live extremes widen the domain, and a fixed color changes.
  const recolor = await ready();
  measure('recolor', (i) => at(recolor, i, { traces: traces(rows, lookAt(i + 1)) }));
  // A new colormap; for fixed traces, a new theme's trace color.
  const palette = await ready();
  measure('palette', (i) =>
    at(palette, i, {
      traces: traces(rows, { ...lookAt(0), colormap: i % 2 ? 'viridis' : 'magma' }),
      traceColor: i % 2 ? [0.23, 0.72, 0.88, 0.7] : [0.88, 0.5, 0.2, 0.7],
    }),
  );
  // Both in one change, as a live run streams with a global domain.
  let live = grid(rows);
  const both = await ready();
  measure('stream frame, new look', async (i) => {
    live = appendData(live, [voltages(rows, frames + i)]);
    both.set({ source: live, traces: traces(rows, lookAt(i + 1)) });
    await draw(device, both, frames + i, 'complete');
  });
  // A live run of growing extremes with fitted values, as Studio streams one: mapped traces' global
  // domain widens with each frame, and fixed colors stay as they are.
  let swollen = grid(rows);
  const growing = await ready();
  measure('stream frame, growing extremes', async (i) => {
    swollen = appendData(swollen, [swelling(rows, frames + i)]);
    growing.set({
      source: swollen,
      traces: traces(rows, { ...lookAt(i + 1), color: lookAt(0).color }),
    });
    await draw(device, growing, frames + i, 'complete');
  });
  // Selecting a row draws it over the rest; clearing removes it.
  const select = await ready();
  measure('select', (i) => {
    select.select(i % 2 ? [] : [{ source: select.config.source, index: busIndex(rows), row: 7 }]);
    return draw(device, select, 0, 'complete');
  });
  // A new window draws history again, behind the shown image.
  const windowed = await ready();
  measure('change window', (i) =>
    at(windowed, i, { camera: { x: [0, frames * 4 + 1 + (i % 2)] } }),
  );
  // A new width moves every line's pixels.
  const width = await ready();
  measure('trace width', (i) => at(width, i, { traceWidthPx: i % 2 ? 1.25 : 2 }));
  // A small trace comes and goes beside the rest.
  const adding = await ready();
  measure('add trace', (i) =>
    at(adding, i, {
      traces: {
        ...traces(rows, lookAt(0)),
        extra:
          i % 2
            ? null
            : { from: 'Bus', y: 'voltage', rows: { kind: 'range', offset: 0, count: 16 } },
      },
    }),
  );
  // A shade that moves every frame.
  const shaded = await ready({ shade: pulse() });
  measure('animated shade', () => draw(device, shaded));
});
