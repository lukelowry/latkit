import { Data, Patch, field, reference, type ColormapName, type Scene } from 'latkit';
import type { Stage } from '../ui/stage.js';
import { Body, ROOM, STEP, type Controls } from './body.js';
import { loadMesh } from './mesh.js';

/** Seconds of frames kept to replay and scrub. */
const HISTORY = 20;
/** Seconds the plot shows. */
const WINDOW = 12;
/** What the bunny can be painted by. Each domain starts below rest, so a bunny at rest draws bright. */
const PAINTS: Record<
  string,
  { label: string; field: string; colormap: ColormapName; domain: [number, number]; legend: string }
> = {
  strain: {
    label: 'Strain',
    field: 'strain',
    colormap: 'turbo',
    domain: [-0.05, 0.35],
    legend: 'Strain 0 – 0.35 m',
  },
  speed: {
    label: 'Speed',
    field: 'speed',
    colormap: 'plasma',
    domain: [-1, 9],
    legend: 'Speed 0 – 9 m/s',
  },
  height: {
    label: 'Height',
    field: 'z',
    colormap: 'viridis',
    domain: [-0.5, 4],
    legend: 'Height 0 – 4 m',
  },
};
const SERIES = [
  { field: 'height', label: 'Center height', color: '#66c7ff' },
  { field: 'speed', label: 'Mean speed', color: '#ff8f52' },
  { field: 'volume', label: 'Volume', color: '#cc9eff' },
];
const THEME = {
  base: 'dark',
  background: '#090c11',
  grid: '#ffffff1c',
  shading: 0.7,
  shadow: '#00000073',
} as const;

export default async function bunny(stage: Stage): Promise<void> {
  const mesh = await loadMesh(new URL('./stanford-bunny.bin', import.meta.url));
  const body = new Body(mesh);
  const controls: Controls = { gravity: 9.81, firmness: 0.45, inflate: 1, wind: false };
  let paint = 'strain';
  let timeScale = 1;
  let carry = 0;

  // The mesh once; then every step, a frame of every vertex and of the body as a whole.
  const data = new Data('bunny').apply(
    new Patch()
      .axis('time', 's')
      .set('Vertex', mesh.count, {})
      .set('Spring', mesh.springs.a.length, {
        a: reference('Vertex', mesh.springs.a),
        b: reference('Vertex', mesh.springs.b),
      })
      .set('Face', mesh.faces.a.length, {
        a: reference('Vertex', mesh.faces.a),
        b: reference('Vertex', mesh.faces.b),
        c: reference('Vertex', mesh.faces.c),
      })
      .set('Corner', 4, { x: [-ROOM, ROOM, ROOM, -ROOM], y: [-ROOM, -ROOM, ROOM, ROOM] })
      .set('Wall', 4, {
        from: reference('Corner', [0, 1, 2, 3]),
        to: reference('Corner', [1, 2, 3, 0]),
      })
      .set('Body', 1, {}),
  );

  // The faces are lit and cast their shadow on the floor; the vertices they join are the dots you
  // grab.
  const room = (live: boolean): Scene => {
    const p = PAINTS[paint]!;
    return {
      space: { plane: { grid: { lines: 1 } } },
      theme: THEME,
      controls: { pickRadius: 14 },
      marks: [
        {
          vertices: {
            of: ['bunny', 'Corner'],
            position: ['x', 'y'],
            radius: 3,
            color: '#f09478aa',
            pick: false,
          },
        },
        {
          edges: {
            of: ['bunny', 'Wall'],
            ends: ['from', 'to'],
            color: '#f0947866',
            width: 1.5,
            pick: false,
          },
        },
        { faces: { of: ['bunny', 'Face'], corners: ['a', 'b', 'c'], pick: false, shadow: true } },
        {
          edges: {
            of: ['bunny', 'Spring'],
            ends: ['a', 'b'],
            color: '#ffffff14',
            width: 1,
            pick: false,
          },
        },
        {
          vertices: {
            of: ['bunny', 'Vertex'],
            position: ['x', 'y'],
            elevation: 'z',
            radius: 1.6,
            color: field(p.field)
              .colormap(p.colormap)
              .domain(...p.domain),
            select: false,
            drag: live,
          },
        },
      ],
    };
  };

  const space = stage.view(room(true), {
    label: 'The bunny: drag it to pull and fling it, click it to poke it',
  });
  space.camera = { center: [0, 0], zoom: 6, pitch: 58, bearing: 30 };
  space.fit({ bounds: { min: [-ROOM, -ROOM, 0], max: [ROOM, ROOM, 2.4] } });

  const act = (run: () => void) => () => {
    playback.play();
    run();
  };
  stage.section('Actions').actions([
    { label: 'Jump', key: ' ', run: act(() => body.jump()) },
    { label: 'Squash', key: 's', run: act(() => body.squash()) },
    { label: 'Explode', key: 'e', run: act(() => body.explode()) },
    { label: 'Drop', key: 'd', run: act(() => body.drop()) },
    {
      label: 'Poke',
      key: 'p',
      run: act(() => body.poke(Math.floor(Math.random() * mesh.count), 9)),
    },
  ]);
  const world = stage.section('World');
  world.toggle('Wind', 'w', false, (on) => (controls.wind = on));
  world.toggle('Orbit', 'o', false, (on) => (space.orbit = on ? 12 : 0));
  world.choice(
    'Gravity',
    [
      ['Space 0', 0],
      ['Moon 1.6', 1.62],
      ['Earth 9.8', 9.81],
      ['Jupiter 24.8', 24.8],
    ],
    9.81,
    (g) => {
      controls.gravity = g;
    },
  );
  world.choice(
    'Time',
    [
      ['1×', 1],
      ['0.5×', 0.5],
      ['0.2×', 0.2],
    ],
    1,
    (s) => (timeScale = s),
  );
  const material = stage.section('Material');
  material.range(
    'Firmness',
    {
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.45,
      format: (v) => (v < 0.2 ? 'Jelly' : v < 0.6 ? 'Gummy' : 'Rubber'),
    },
    (v) => {
      controls.firmness = v;
    },
  );
  material.range(
    'Inflate',
    { min: 0.5, max: 1.8, step: 0.01, value: 1, format: (v) => `${Math.round(v * 100)}%` },
    (v) => {
      controls.inflate = v;
    },
  );
  const legend = stage.legend();
  const repaint = (p: string) => {
    paint = p;
    space.show(room(playback.mode === 'live'));
    legend.ramp(PAINTS[p]!.colormap, PAINTS[p]!.legend);
  };
  material.choice(
    'Color',
    Object.entries(PAINTS).map(([key, p]) => [p.label, key] as const),
    paint,
    repaint,
  );

  const monitor = stage.section('Monitor');
  monitor.series(SERIES);
  const plot = monitor.view(
    {
      space: { plot: { x: { label: 'Time (s)' }, y: { label: 'm · m/s · volume' } } },
      theme: THEME,
      controls: { pan: false, zoom: false, turn: false },
      marks: SERIES.map((s) => ({
        lines: { of: ['bunny', 'Body'], samples: s.field, color: s.color, width: 2 },
      })),
    },
    { label: 'Center height, speed, and volume', height: 220 },
  );

  const playback = stage.playback({
    replay: { seconds: 3, rate: 0.3 },
    show(at) {
      space.at = at;
      plot.at = at;
      const x0 = Math.max(playback.start, at - WINDOW * 0.85);
      plot.camera = { x: [x0, x0 + WINDOW], y: null };
    },
    change(live) {
      // Paused, a press pans instead of grabbing.
      space.show(room(live));
      if (!live) body.release();
    },
  });

  const frame = body.frame();
  const publish = () => {
    body.sample(frame);
    const [height, speed, volume] = body.metrics();
    data.apply(
      new Patch()
        .append(body.time, 'Vertex', { ...frame })
        .append(body.time, 'Body', { height: [height], speed: [speed], volume: [volume] })
        .forget(body.time - HISTORY),
    );
    space.setData(data);
    plot.setData(data);
    playback.record(data.span!);
  };

  space.on('drag', ({ phase, hit, position }) => {
    if (phase === 'start') body.grab(hit.row.id as number, position);
    else if (phase === 'move') body.drag(position);
    else body.release();
  });
  space.on('click', (hit) => act(() => body.poke(hit.row.id as number))());

  const meter = stage.meter(space);
  meter.note(() => {
    const [height, speed, volume] = body.metrics();
    return `center ${height.toFixed(2)} m  ·  ${speed.toFixed(1)} m/s  ·  volume ${(volume * 100).toFixed(0)}%`;
  });
  stage.frame((dt) => {
    if (playback.mode !== 'live') return;
    meter.measure('simulate', () => {
      carry = Math.min(carry + dt * timeScale, 16 * STEP);
      const steps = body.advance(carry, controls);
      carry -= steps * STEP;
      if (steps) publish();
    });
  });

  stage.detail(
    `${mesh.count.toLocaleString()} vertices · ${mesh.springs.a.length.toLocaleString()} springs · ${mesh.faces.a.length.toLocaleString()} faces`,
  );
  legend.ramp(PAINTS[paint]!.colormap, PAINTS[paint]!.legend);
  body.drop(true);
  publish();
}
