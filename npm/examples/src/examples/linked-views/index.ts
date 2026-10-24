/**
 * One record in two views on one canvas: a lattice of nodes on a tilted plane, each standing on a
 * pole as high as its signal, and the signals traced on a plot. One playhead moves both; play at a
 * speed or scrub, and read where each view stands. Select nodes in either view and the other selects
 * them too, their traces standing out.
 */
import {
  Data,
  Patch,
  field,
  reference,
  selected,
  units,
  when,
  zoom,
  type Rows,
  type Scene,
  type Size,
  type View,
} from '../../latkit.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';

/** Nodes a side of the lattice, frames recorded, seconds between them, and a full signal's height. */
const SIDE = 20;
const FRAMES = 1201;
const STEP = 0.05;
const HEIGHT = 3;
/** Every `TRACED`th node, from the middle of the first run, is traced when few are. */
const TRACED = 25;

/**
 * The record: nodes at whole x and y, linked to their neighbors right and down, each a signal
 * rippling across the lattice, `0.5 + 0.45 sin(0.37 x + 1.3 t) cos(0.31 y - 0.7 t)`.
 */
function record(): Data {
  const n = SIDE * SIDE;
  const x = Float64Array.from({ length: n }, (_, i) => i % SIDE);
  const y = Float64Array.from({ length: n }, (_, i) => Math.floor(i / SIDE));
  const traced = Float64Array.from({ length: n }, (_, i) => Number(i % TRACED === 10));
  const [from, to]: [number[], number[]] = [[], []];
  const link = (a: number, b: number) => {
    from.push(a);
    to.push(b);
  };
  for (let i = 0; i < n; i++) {
    if (x[i]! < SIDE - 1) link(i, i + 1);
    if (y[i]! < SIDE - 1) link(i, i + SIDE);
  }
  const patch = new Patch()
    .axis('time', 's')
    .set('Node', { count: n }, { x, y, traced })
    .set(
      'Link',
      { count: from.length },
      { from: reference('Node', from), to: reference('Node', to) },
    );
  // Every frame in one append, frame by frame.
  const times = Array.from({ length: FRAMES }, (_, f) => f * STEP);
  const signal = new Float32Array(FRAMES * n);
  times.forEach((t, f) => {
    for (let i = 0; i < n; i++)
      signal[f * n + i] =
        0.5 + 0.45 * Math.sin(0.37 * x[i]! + 1.3 * t) * Math.cos(0.31 * y[i]! - 0.7 * t);
  });
  return new Data('signals').apply(patch.append(times, 'Node', { signal }));
}

export default function page(stage: Stage): void {
  const duration = (FRAMES - 1) * STEP;
  let few = true;
  const look = {
    height: HEIGHT,
    poles: true,
    /** Whether signals read their last sample as it was, rather than eased between samples. */
    held: false,
    size: 'pixels' as 'pixels' | 'zoom' | 'units',
  };
  /** Each node's signal: eased between samples, or held at the last one. */
  const reading = () => (look.held ? field('signal').step() : field('signal'));
  const signal = () => reading().colormap('viridis').domain(0, 1);
  /** A node's radius: CSS pixels, grown with the zoom, or units of the plane kept within pixels. */
  const radius = (): Size =>
    look.size === 'zoom'
      ? zoom().mul(0.9).clamp(1.5, 9)
      : look.size === 'units'
        ? units(0.18, { atLeast: 1.5, atMost: 24 })
        : 3.4;
  const lattice = (): Scene => ({
    space: { plane: { grid: 'off' } },
    theme: { ...theme, dim: 0.25 },
    marks: [
      { edges: { of: ['signals', 'Link'], ends: ['from', 'to'], width: 1, color: '#3a4556' } },
      ...(look.poles
        ? [
            {
              edges: {
                of: ['signals', 'Node'] as [string, string],
                poles: true,
                width: 1.5,
                color: signal(),
              },
            },
          ]
        : []),
      {
        vertices: {
          of: ['signals', 'Node'],
          position: ['x', 'y'],
          elevation: reading().mul(look.height),
          radius: radius(),
          color: signal(),
        },
      },
    ],
  });
  const traces = (): Scene => ({
    space: {
      plot: { x: { label: 'Time (s)' }, y: { label: 'Signal', format: 'fixed', precision: 2 } },
    },
    theme: { ...theme, dim: 0.2 },
    ease: 0,
    marks: [
      {
        lines: {
          of: ['signals', 'Node'],
          trace: 'signal',
          color: signal(),
          // Selected nodes' traces stand out, the rest dim.
          width: when(selected())
            .then(3)
            .otherwise(few ? 1.5 : 0.8),
          ...(few ? { visible: field('traced').gt(0.5).or(selected()) } : {}),
        },
      },
    ],
  });
  const [plane, plot] = stage.panels([lattice(), traces()], {
    label: 'A lattice on poles beside its signals traced: one playhead moves both',
    panels: [
      [0, 0, 0.55, 1],
      [0.55, 0, 0.45, 1],
    ],
  }) as [View, View];
  const data = record();
  plane.setData(data);
  plot.setData(data);
  plane.camera = { center: [(SIDE - 1) / 2, (SIDE - 1) / 2, 0], zoom: 3, pitch: 50, bearing: 20 };
  plane.fit();
  plot.camera = { x: [0, duration], y: [0, 1] };
  const restyle = () => {
    plane.show(lattice());
    plot.show(traces());
  };

  // What either view selects, the other selects too.
  const same = (a: readonly Rows[], b: readonly Rows[]) => JSON.stringify(a) === JSON.stringify(b);
  for (const [from, to] of [
    [plane, plot],
    [plot, plane],
  ] as const)
    from.on('select', () => {
      if (!same(from.selection, to.selection)) to.select(from.selection);
    });

  const views = [
    ['Lattice', plane],
    ['Plot', plot],
  ] as const;
  const playback = stage.playback({
    live: false,
    show(at) {
      for (const [, view] of views) view.at = at;
    },
  });
  playback.record([0, duration]);

  // Where each view stands: both draw in the canvas's one frame, so they never part.
  const where = stage.section('View stats', false);
  const lines = views.map(() => where.note());
  let read = 0;
  stage.frame(() => {
    if (performance.now() - read < 250) return;
    read = performance.now();
    views.forEach(([name, view], i) => {
      const { frames, cpuMs } = view.stats;
      lines[i]!.textContent =
        `${name} at ${view.at.toFixed(3)} s · ${frames} frames · ${cpuMs.toFixed(1)} ms`;
    });
  });

  const play = stage.section('Playback');
  play.speed([0.25, 1, 4], 1, (rate) => (playback.rate = rate));
  play.choice(
    'Traces',
    [
      [`${(SIDE * SIDE) / TRACED} and the selected`, true],
      [`All ${SIDE * SIDE}`, false],
    ] as const,
    few,
    (next) => {
      few = next;
      plot.show(traces());
    },
  );
  play.toggle('Hold samples', 'h', look.held, (on) => ((look.held = on), restyle()));
  const shape = stage.section('Lattice');
  shape.range(
    'Height',
    { min: 0, max: 6, step: 0.25, value: look.height, format: (v) => `${v.toFixed(2)} units` },
    (height) => {
      look.height = height;
      plane.show(lattice());
    },
  );
  shape.choice(
    'Node size',
    [
      ['Pixels', 'pixels'],
      ['Grows with zoom', 'zoom'],
      ['Units of the plane', 'units'],
    ] as const,
    look.size,
    (size) => ((look.size = size), plane.show(lattice())),
  );
  shape.toggle('Poles', 'p', look.poles, (on) => ((look.poles = on), plane.show(lattice())));
  shape.note('Select nodes on the lattice or traces on the plot: both views select them.');
  const legend = stage.legend('top');
  legend.ramp('viridis', 'Signal 0–1');

  stage.meter(plane);
  stage.detail(
    `${(SIDE * SIDE).toLocaleString()} nodes · ${FRAMES.toLocaleString()} frames over ${duration} s`,
  );
}
