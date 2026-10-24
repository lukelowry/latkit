/**
 * A soft bunny of springs in a room: hop, squash, poke, fling, or pop it, and replay or scrub what
 * it did. Its faces darken turning from the light over soft footprints on the floor; its vertices,
 * their dots hidden until the mesh shows, are what the pointer drags; and a plot traces its height,
 * speed, and volume.
 */
import {
  Data,
  Patch,
  field,
  reference,
  units,
  type ColormapName,
  type Grid,
  type Scene,
} from '../../latkit.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';
import { Body, ROOM, STEP, type Controls } from './body.js';
import { loadMesh } from './mesh.js';

/** Seconds of frames kept to replay and scrub. */
const HISTORY = 20;
/** Seconds of simulation between recorded frames, whatever the display's refresh rate. */
const RECORD = 1 / 60;
/** Seconds the plot shows. */
const WINDOW = 12;
/** What the bunny can be painted by. Each domain starts below rest, so a bunny at rest draws bright. */
const PAINTS: Record<
  string,
  { label: string; field: string; colormap: ColormapName; domain: [number, number]; legend: string }
> = {
  solid: {
    label: 'Pearl',
    field: 'strain',
    colormap: 'turbo',
    domain: [-0.05, 0.35],
    legend: '',
  },
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
  ...theme,
  shading: 0.7,
} as const;

// A soft footprint on the floor under the bunny and each of its pieces, darker the nearer they sit:
// a marker of our own, in WGSL, its darkness read from each row's `opacity`.
const CONTACT_SHADOW = `fn marker(f: MarkerFragment) -> MarkerColor {
  let p = f.p / max(f.half, vec2f(0.001));
  let d = length(p);
  let alpha = (1.0 - smoothstep(0.15, 1.0, d)) * f.input[0];
  return MarkerColor(vec4f(0.0, 0.0, 0.0, alpha), (d - 1.0) * f.half.x);
}`;

export default async function bunny(stage: Stage): Promise<void> {
  const mesh = await loadMesh(new URL('./stanford-bunny.bin', import.meta.url));
  if (stage.signal.aborted) return;
  const body = new Body(mesh);
  // Reduced motion hops lower, pops gentler, and never orbits.
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.addEventListener(
    'change',
    () => {
      if (reducedMotion.matches) space.orbit = 0;
    },
    { signal: stage.signal },
  );
  const controls: Controls = { gravity: 9.81, firmness: 0.45, inflate: 1, wind: false };
  /** Sets a control, waking the body: a resting body answers new gravity or a new material. */
  const waking =
    <T>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      body.wake();
    };
  let paint = 'solid';
  let inspect = false;
  /** How faces turn from the light, the floor's grid, and the mesh's dots. */
  const lit: { shading: number; grid: 'lines' | 'dots' | 'off'; dots: number } = {
    shading: THEME.shading,
    grid: 'lines',
    dots: 1.5,
  };
  const GRIDS: Record<typeof lit.grid, Grid> = {
    lines: { lines: { pitch: 1 } },
    dots: { dots: { pitch: 0.5 } },
    off: 'off',
  };
  let fragments = false;
  let timeScale = 1;
  let carry = 0;
  let recordAt = 0;

  // The mesh once; then every step, a frame of every vertex and of the body as a whole.
  const data = new Data('bunny').apply(
    new Patch()
      .axis('time', 's')
      .set('Vertex', { count: mesh.count }, {})
      .set(
        'Spring',
        { count: mesh.springs.a.length },
        {
          a: reference('Vertex', mesh.springs.a),
          b: reference('Vertex', mesh.springs.b),
        },
      )
      .set(
        'Face',
        { count: mesh.faces.a.length },
        {
          a: reference('Vertex', mesh.faces.a),
          b: reference('Vertex', mesh.faces.b),
          c: reference('Vertex', mesh.faces.c),
        },
      )
      .set('ChunkVertex', { count: body.burst.count }, {})
      .set(
        'ChunkFace',
        { count: body.burst.faces.a.length },
        {
          a: reference('ChunkVertex', body.burst.faces.a),
          b: reference('ChunkVertex', body.burst.faces.b),
          c: reference('ChunkVertex', body.burst.faces.c),
        },
      )
      .set('Corner', { count: 4 }, { x: [-ROOM, ROOM, ROOM, -ROOM], y: [-ROOM, -ROOM, ROOM, ROOM] })
      .set(
        'Wall',
        { count: 4 },
        {
          from: reference('Corner', [0, 1, 2, 3]),
          to: reference('Corner', [1, 2, 3, 0]),
        },
      )
      .set('Body', { count: 1 }, {}),
  );

  data.apply(new Patch().set('Shadow', { count: body.burst.chunks.length + 1 }, {}));

  // Faces lit from the camera over soft footprints; the vertices stay pickable, their dots hidden.
  const room = (live: boolean): Scene => {
    const p = PAINTS[paint]!;
    return {
      space: { plane: { grid: GRIDS[lit.grid] } },
      // The mesh's dots and springs draw the theme's sizes.
      theme: { ...THEME, shading: lit.shading, vertexRadius: inspect ? lit.dots : 0, edgeWidth: 1 },
      controls: { pickRadius: 14 },
      marks: [
        {
          vertices: {
            of: ['bunny', 'Shadow'],
            position: ['x', 'y'],
            size: [units(field('radius').mul(2)), units(field('radius'))],
            marker: { wgsl: { source: CONTACT_SHADOW, inputs: [field('opacity')] } },
            color: '#000000',
            pick: false,
          },
        },
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
        {
          faces: {
            of: ['bunny', fragments ? 'ChunkFace' : 'Face'],
            corners: ['a', 'b', 'c'],
            ...(paint === 'solid' ? { color: '#edccb4' } : {}),
            pick: false,
          },
        },
        {
          edges: {
            of: ['bunny', 'Spring'],
            ends: ['a', 'b'],
            color: '#ffffff14',
            pick: false,
            visible: inspect && !fragments,
          },
        },
        {
          vertices: {
            of: ['bunny', fragments ? 'ChunkVertex' : 'Vertex'],
            position: ['x', 'y'],
            elevation: 'z',
            color:
              paint === 'solid'
                ? inspect
                  ? '#edccb4'
                  : '#edccb400'
                : field(p.field)
                    .colormap(p.colormap)
                    .domain(...p.domain),
            select: false,
            drag: live && !fragments,
            pick: !fragments,
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
  const actions = stage.section('Actions');
  actions.actions([
    { label: 'Hop', key: ' ', run: act(() => body.hop(reducedMotion.matches)) },
    { label: 'Squash', key: 's', run: act(() => body.squash()) },
    { label: 'Pop', key: 'e', run: act(() => body.pop(reducedMotion.matches)) },
    { label: 'Drop', key: 'd', run: act(() => body.drop()) },
    {
      label: 'Poke',
      key: 'p',
      run: act(() => body.poke(Math.floor(Math.random() * mesh.count), 9)),
    },
  ]);
  const popButton = actions.element.querySelectorAll('button')[2]!;
  popButton.title = 'Pop into soft pieces; press again to gather them';
  const squashButton = actions.element.querySelectorAll('button')[1]!;
  squashButton.title = 'Hold to squash; release to rebound';
  squashButton.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      squashButton.setPointerCapture(event.pointerId);
      act(() => body.squash(true))();
    },
    { signal: stage.signal },
  );
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
    squashButton.addEventListener(event, () => body.endSquash(), { signal: stage.signal });
  const world = stage.section('Physics');
  world.toggle(
    'Wind',
    'w',
    false,
    waking((on: boolean) => (controls.wind = on)),
  );
  world.toggle('Orbit', 'o', false, (on) => (space.orbit = on && !reducedMotion.matches ? 12 : 0));
  world.choice(
    'Gravity',
    [
      ['Space 0', 0],
      ['Moon 1.6', 1.62],
      ['Earth 9.8', 9.81],
      ['Jupiter 24.8', 24.8],
    ],
    9.81,
    waking((g: number) => (controls.gravity = g)),
  );
  world.speed([1, 0.5, 0.2], 1, (rate) => (timeScale = rate));
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
    waking((v: number) => (controls.firmness = v)),
  );
  material.range(
    'Inflate',
    { min: 0.5, max: 1.8, step: 0.01, value: 1, format: (v) => `${Math.round(v * 100)}%` },
    waking((v: number) => (controls.inflate = v)),
  );
  const legend = stage.legend();
  const repaint = (p: string) => {
    paint = p;
    space.show(room(playback.mode === 'live'));
    legend.ramp(PAINTS[p]!.colormap, PAINTS[p]!.legend);
    legend.hidden = p === 'solid';
  };
  material.toggle('Mesh', 'i', false, (on) => {
    inspect = on;
    space.show(room(playback.mode === 'live'));
  });
  material.choice(
    'Color',
    Object.entries(PAINTS).map(([key, p]) => [p.label, key] as const),
    paint,
    repaint,
  );
  const light = stage.section('Light', false);
  light.range(
    'Shading',
    { min: 0, max: 1, step: 0.05, value: lit.shading, format: (v) => `${Math.round(v * 100)}%` },
    (shading) => {
      lit.shading = shading;
      space.show(room(playback.mode === 'live'));
    },
  );
  light.range(
    'Mesh dots',
    { min: 0.5, max: 4, step: 0.25, value: lit.dots, format: (v) => `${v.toFixed(2)} px` },
    (dots) => {
      lit.dots = dots;
      space.show(room(playback.mode === 'live'));
    },
  );
  light.choice(
    'Floor',
    [
      ['Lines', 'lines'],
      ['Dots', 'dots'],
      ['Bare', 'off'],
    ] as const,
    lit.grid,
    (grid) => {
      lit.grid = grid;
      space.show(room(playback.mode === 'live'));
    },
  );

  const monitor = stage.section('History');
  monitor.series(SERIES);
  const plot = monitor.view(
    {
      space: { plot: { x: { label: 'Time (s)' }, y: { label: 'm · m/s · volume' } } },
      theme: THEME,
      controls: 'inspect',
      marks: SERIES.map((s) => ({
        lines: { of: ['bunny', 'Body'], trace: s.field, color: s.color, width: 2 },
      })),
    },
    { label: 'Center height, speed, and volume', height: 220 },
  );

  const playback = stage.playback({
    replay: { seconds: 5, rate: 0.3 },
    show(at) {
      const pieces = data.get('Body', 0, 'phase', at) === 1;
      if (pieces !== fragments) {
        fragments = pieces;
        space.show(room(playback.mode === 'live'));
      }
      space.at = at;
      plot.at = at;
      const x0 = Math.max(playback.start, at - WINDOW * 0.85);
      plot.camera = { x: [x0, x0 + WINDOW], y: null };
    },
    change(live) {
      // Paused, a press pans instead of grabbing.
      space.show(room(live));
      if (!live) {
        body.release(true);
        body.endSquash();
      }
    },
  });

  const frame = body.frame();
  const chunkFrame = body.burst.frame();
  const shadow = {
    x: new Float32Array(body.burst.chunks.length + 1),
    y: new Float32Array(body.burst.chunks.length + 1),
    radius: new Float32Array(body.burst.chunks.length + 1),
    opacity: new Float32Array(body.burst.chunks.length + 1),
  };
  let recordedChunks = false;
  let wasBurst = false;
  const publish = () => {
    body.sample(frame);
    const [height, speed, volume] = body.metrics();
    shadow.opacity.fill(0);
    if (body.burst.active) {
      body.burst.chunks.forEach((chunk, i) => {
        shadow.x[i + 1] = chunk.position[0];
        shadow.y[i + 1] = chunk.position[1];
        shadow.radius[i + 1] = chunk.radius + chunk.position[2] * 0.12;
        shadow.opacity[i + 1] = 0.32 / (1 + chunk.position[2]);
      });
    } else {
      shadow.x[0] = frame.x.reduce((sum, v) => sum + v, 0) / mesh.count;
      shadow.y[0] = frame.y.reduce((sum, v) => sum + v, 0) / mesh.count;
      shadow.radius[0] = 0.85 * Math.cbrt(controls.inflate) + height * 0.15;
      shadow.opacity[0] = 0.42 / (1 + height * height * 0.4);
    }
    const patch = new Patch()
      .append(body.time, 'Vertex', { ...frame })
      .append(body.time, 'Shadow', shadow)
      .append(body.time, 'Body', {
        height: [height],
        speed: [speed],
        volume: [Number.isFinite(volume) ? volume : null],
        phase: [body.burst.active ? 1 : 0],
      })
      .forget(body.time - HISTORY);
    if (body.burst.active || wasBurst || !recordedChunks) {
      body.burst.sample(chunkFrame, STEP);
      patch.append(body.time, 'ChunkVertex', { ...chunkFrame });
      recordedChunks = true;
    }
    wasBurst = body.burst.active;
    data.apply(patch);
    space.setData(data);
    plot.setData(data);
    playback.record(data.span!);
    popButton.firstChild!.textContent = body.burst.active ? 'Gather' : 'Pop';
  };

  space.on('drag', ({ phase, hit, position }) => {
    if (phase === 'start') body.grab(hit.row.id as number, position);
    else if (phase === 'move') body.drag(position);
    else body.release();
  });
  space.on('click', ({ hit }) => act(() => body.poke(hit.row.id as number))());

  const canvas = stage.regions.main.querySelector('canvas')!;
  // The JS drag event intentionally combines release and cancellation. Capture cancellation
  // before the view's bubbling listener, so it cannot leave a throw behind.
  canvas.addEventListener('pointercancel', () => body.release(true), {
    capture: true,
    signal: stage.signal,
  });
  addEventListener(
    'blur',
    () => {
      body.release(true);
      body.endSquash();
    },
    { signal: stage.signal },
  );

  const meter = stage.meter(space);
  meter.note(() => {
    const at = playback.at;
    const height = (data.get('Body', 0, 'height', at) as number | null) ?? 0;
    const speed = (data.get('Body', 0, 'speed', at) as number | null) ?? 0;
    const volume = data.get('Body', 0, 'volume', at) as number | null;
    const state =
      playback.mode === 'live' ? body.state : playback.mode === 'playing' ? 'replay' : 'paused';
    return `${state}  ·  center ${height.toFixed(2)} m  ·  ${speed.toFixed(1)} m/s  ·  ${volume !== null && Number.isFinite(volume) ? `volume ${(volume * 100).toFixed(0)}%` : '24 pieces'}`;
  });
  stage.frame((dt) => {
    if (playback.mode !== 'live') return;
    // A resting bunny steps and records nothing, so both views sleep until something acts on it.
    if (body.asleep) {
      carry = 0;
      return;
    }
    meter.measure('simulate', () => {
      carry = Math.min(carry + dt * timeScale, 16 * STEP);
      const steps = body.advance(carry, controls);
      carry -= steps * STEP;
      // Recorded at a fixed rate of simulated time, and once more as it comes to rest.
      if (steps && (body.time + STEP / 2 >= recordAt || body.asleep)) {
        publish();
        recordAt = body.time + RECORD;
      }
    });
  });

  stage.detail(
    `${mesh.count.toLocaleString()} vertices · ${mesh.springs.a.length.toLocaleString()} springs · ${mesh.faces.a.length.toLocaleString()} faces`,
  );
  legend.ramp(PAINTS[paint]!.colormap, PAINTS[paint]!.legend);
  legend.hidden = true;
  body.drop(true);
  publish();
}
