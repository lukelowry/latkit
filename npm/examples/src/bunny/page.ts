import { Data, Patch, field, reference, units, type ColormapName, type Scene } from '../latkit.js';
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
  base: 'dark',
  background: '#090c11',
  grid: '#ffffff1c',
  shading: 0.7,
} as const;

// A soft floor footprint avoids self-shadow acne on deforming triangles in the packaged renderer.
// This is a custom marker through the public JS scene API, with no renderer changes.
const CONTACT_SHADOW = `fn marker(f: MarkerFragment) -> MarkerColor {
  let p = f.p / max(f.half, vec2f(0.001));
  let d = length(p);
  let alpha = (1.0 - smoothstep(0.15, 1.0, d)) * f.input[0];
  return MarkerColor(vec4f(0.0, 0.0, 0.0, alpha), (d - 1.0) * f.half.x);
}`;

export default async function bunny(stage: Stage): Promise<void> {
  const mesh = await loadMesh(new URL('./stanford-bunny.bin', import.meta.url));
  const body = new Body(mesh);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const controls: Controls = {
    gravity: 9.81,
    firmness: 0.45,
    inflate: 1,
    wind: false,
    reducedMotion: reducedMotion.matches,
  };
  reducedMotion.addEventListener(
    'change',
    () => {
      controls.reducedMotion = reducedMotion.matches;
      if (reducedMotion.matches) space.orbit = 0;
    },
    { signal: stage.signal },
  );
  let paint = 'solid';
  let inspect = false;
  let fragments = false;
  let timeScale = 1;
  let carry = 0;

  // The mesh once; then every step, a frame of every vertex and of the body as a whole.
  let data = new Data('bunny').apply(
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
      .set('ChunkVertex', body.burst.count, {})
      .set('ChunkFace', body.burst.faces.a.length, {
        a: reference('ChunkVertex', body.burst.faces.a),
        b: reference('ChunkVertex', body.burst.faces.b),
        c: reference('ChunkVertex', body.burst.faces.c),
      })
      .set('Corner', 4, { x: [-ROOM, ROOM, ROOM, -ROOM], y: [-ROOM, -ROOM, ROOM, ROOM] })
      .set('Wall', 4, {
        from: reference('Corner', [0, 1, 2, 3]),
        to: reference('Corner', [1, 2, 3, 0]),
      })
      .set('Body', 1, {}),
  );

  data = data.apply(new Patch().set('Shadow', body.burst.chunks.length + 1, {}));

  // Lit faces and soft contact shadows; the vertices remain pickable with inspection dots hidden.
  const room = (live: boolean): Scene => {
    const p = PAINTS[paint]!;
    return {
      space: { plane: { grid: { lines: 1 } } },
      theme: THEME,
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
            shadow: false,
          },
        },
        {
          edges: {
            of: ['bunny', 'Spring'],
            ends: ['a', 'b'],
            color: '#ffffff14',
            width: 1,
            pick: false,
            visible: inspect && !fragments,
          },
        },
        {
          vertices: {
            of: ['bunny', fragments ? 'ChunkVertex' : 'Vertex'],
            position: ['x', 'y'],
            elevation: 'z',
            radius: inspect ? 1.6 : 0,
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
    { label: 'Hop', key: ' ', run: act(() => body.jump()) },
    { label: 'Squash', key: 's', run: act(() => body.squash()) },
    { label: 'Pop', key: 'e', run: act(() => body.explode()) },
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
  actions.toggle('Playful', 'a', false, (on) => (controls.playful = on));
  const world = stage.section('World');
  world.toggle('Wind', 'w', false, (on) => (controls.wind = on));
  world.toggle('Orbit', 'o', false, (on) => (space.orbit = on && !controls.reducedMotion ? 12 : 0));
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
  const legendElement = stage.regions.main.querySelector<HTMLElement>('.legend')!;
  const repaint = (p: string) => {
    paint = p;
    space.show(room(playback.mode === 'live'));
    legend.ramp(PAINTS[p]!.colormap, PAINTS[p]!.legend);
    legendElement.style.display = p === 'solid' ? 'none' : '';
  };
  material.toggle('Inspect mesh', 'i', false, (on) => {
    inspect = on;
    space.show(room(playback.mode === 'live'));
  });
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
    data = data.apply(patch);
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
  space.on('click', (hit) => act(() => body.poke(hit.row.id as number))());

  const canvas = stage.regions.main.querySelector('canvas')!;
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const rect = canvas.getBoundingClientRect();
      body.lookAt(space.ground([event.clientX - rect.left, event.clientY - rect.top]));
    },
    { signal: stage.signal },
  );
  canvas.addEventListener('pointerleave', () => body.lookAt(), { signal: stage.signal });
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
  legendElement.style.display = 'none';
  body.drop(true);
  publish();
}
