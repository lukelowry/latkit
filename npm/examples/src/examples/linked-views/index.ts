import { theme } from '../../ui/theme.js';
/**
 * One record in two views on one canvas: a lattice of nodes on a tilted plane, each standing on a
 * pole as high as its signal, and the signals traced on a plot. One playhead moves both; play at a
 * speed or scrub, and read where each view stands.
 */
import { Data, Patch, field, reference, type Scene, type View } from '../../latkit.js';
import type { Stage } from '../../ui/stage.js';

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
  const signal = field('signal').colormap('viridis').domain(0, 1);
  const lattice: Scene = {
    space: { plane: { grid: 'off' } },
    theme,
    marks: [
      { edges: { of: ['signals', 'Link'], ends: ['from', 'to'], width: 1, color: '#3a4556' } },
      { edges: { of: ['signals', 'Node'], poles: true, width: 1.5, color: signal } },
      {
        vertices: {
          of: ['signals', 'Node'],
          position: ['x', 'y'],
          elevation: field('signal').mul(HEIGHT),
          radius: 3.4,
          color: signal,
        },
      },
    ],
  };
  const traces = (): Scene => ({
    space: {
      plot: { x: { label: 'Time (s)' }, y: { label: 'Signal', format: 'fixed', precision: 1 } },
    },
    theme,
    ease: 0,
    marks: [
      {
        lines: {
          of: ['signals', 'Node'],
          trace: 'signal',
          color: signal,
          width: few ? 1.5 : 0.8,
          ...(few ? { visible: field('traced').gt(0.5) } : {}),
        },
      },
    ],
  });
  const [plane, plot] = stage.panels([lattice, traces()], {
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
      [`${(SIDE * SIDE) / TRACED} nodes`, true],
      [`All ${SIDE * SIDE}`, false],
    ] as const,
    few,
    (next) => {
      few = next;
      plot.show(traces());
    },
  );
  const legend = stage.legend('top');
  legend.ramp('viridis', 'Signal 0–1');

  stage.meter(plane);
  stage.detail(
    `${(SIDE * SIDE).toLocaleString()} nodes · ${FRAMES.toLocaleString()} frames over ${duration} s`,
  );
}
