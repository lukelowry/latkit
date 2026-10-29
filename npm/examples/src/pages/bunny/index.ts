/**
 * A soft bunny made of springs, in a room. Hop, squash, poke, fling, or pop it, then replay or scrub
 * its history: every frame of every vertex is recorded, and the views read it back at the
 * timeline's time. Faces darken as they turn from the light, above soft contact shadows drawn by a
 * custom WGSL marker. A plot traces the bunny's height and speed.
 */
import { Data, field, reference, units, type Scene } from 'latkit';
import { choice, page } from '../../shell/page.js';
import { Body, ROOM, STEP } from './body.js';
import { loadMesh } from './mesh.js';

/** Simulated seconds between recorded frames, whatever the display's refresh rate, and the
 * seconds the plot shows. */
const RECORD = 1 / 60;
const WINDOW = 12;
/** The material and the world the bunny lives in. */
const WORLD = { gravity: 9.81, firmness: 0.45, inflate: 1, wind: false };
/** Each coloring: the field it reads, through which colormap, over which values. */
const PAINTS = {
  speed: { field: 'speed', colormap: 'plasma', domain: [-1, 9], legend: 'Speed (m/s)' },
  stress: {
    field: 'strain',
    colormap: 'turbo',
    domain: [-0.05, 0.35],
    legend: 'Stress (m from rest)',
  },
} as const;
const SERIES = [
  { field: 'height', label: 'Center height (m)', color: '#66c7ff' },
  { field: 'speed', label: 'Mean speed (m/s)', color: '#ff8f52' },
];
/** A soft contact shadow, darker the lower the body above it: a custom marker in WGSL that reads
 * its darkness from each row's `opacity`. */
const SHADOW = `fn marker(f: MarkerFragment) -> MarkerColor {
  let d = length(f.p / max(f.half, vec2f(0.001)));
  let alpha = (1.0 - smoothstep(0.15, 1.0, d)) * f.input[0];
  return MarkerColor(vec4f(0.0, 0.0, 0.0, alpha), (d - 1.0) * f.half.x);
}`;

export default page({
  title: 'Soft body',
  inspect: false,
  settings: { paint: choice('Color', { Speed: 'speed', Stress: 'stress' }, { key: 'c' }) },

  async open({ settings, signal, view, actions, timeline, frame, series, detail }) {
    const mesh = await loadMesh(new URL('./stanford-bunny.bin', import.meta.url));
    const body = new Body(mesh);
    const { burst } = body;
    const pieces = burst.chunks.length;
    // The mesh, its pieces once popped, and the room are set once. Each recorded frame then
    // appends every vertex, the shadows, and the body as a whole.
    const data = new Data('bunny')
      .axis('time', 's')
      .set('Vertex', { count: mesh.count })
      .set('Spring', {
        a: reference('Vertex', mesh.springs.a),
        b: reference('Vertex', mesh.springs.b),
      })
      .set('Face', {
        a: reference('Vertex', mesh.faces.a),
        b: reference('Vertex', mesh.faces.b),
        c: reference('Vertex', mesh.faces.c),
      })
      .set('ChunkVertex', { count: burst.count })
      .set('ChunkFace', {
        a: reference('ChunkVertex', burst.faces.a),
        b: reference('ChunkVertex', burst.faces.b),
        c: reference('ChunkVertex', burst.faces.c),
      })
      .set('Corner', { x: [-ROOM, ROOM, ROOM, -ROOM], y: [-ROOM, -ROOM, ROOM, ROOM] })
      .set('Wall', {
        from: reference('Corner', [0, 1, 2, 3]),
        to: reference('Corner', [1, 2, 3, 0]),
      })
      .set('Shadow', { count: pieces + 1 })
      .set('Body', { count: 1 });

    let popped = false;
    let live = true;
    const room = (s: typeof settings): Scene => {
      const paint = PAINTS[s.paint];
      return {
        space: { plane: { grid: { lines: { pitch: 1 } } } },
        theme: {
          base: 'dark',
          background: '#101214',
          grid: '#ffffff1c',
          shading: 0.7,
          vertex: { radius: 0 },
        },
        controls: { pickRadius: 14 },
        marks: [
          {
            vertices: data.table('Shadow'),
            position: ['$x', '$y'],
            size: [units(field('radius').mul(2)), units(field('radius'))],
            marker: { wgsl: { source: SHADOW, inputs: [field('opacity')] } },
            color: '#000000',
            pick: false,
          },
          {
            vertices: data.table('Corner'),
            position: ['$x', '$y'],
            radius: 3,
            color: '#f09478aa',
            pick: false,
          },
          {
            edges: data.table('Wall'),
            ends: ['from', 'to'],
            color: '#f0947866',
            width: 1.5,
            pick: false,
          },
          // Faces without a color blend their corners' colors.
          {
            faces: data.table(popped ? 'ChunkFace' : 'Face'),
            corners: ['a', 'b', 'c'],
            pick: false,
          },
          {
            vertices: data.table(popped ? 'ChunkVertex' : 'Vertex'),
            position: ['$x', '$y'],
            elevation: '$z',
            color: field(paint.field)
              .colormap(paint.colormap)
              .domain(paint.domain[0], paint.domain[1]),
            legend: paint.legend,
            select: false,
            // Outside live mode, a press pans instead of grabbing.
            drag: live && !popped,
            pick: !popped,
          },
        ],
      };
    };
    const space = await view(room, {
      region: [0, 0, 1, 0.74],
      camera: { center: [0, 0], zoom: 6, pitch: 58, bearing: 30 },
      label: 'The bunny: drag it to fling it, click it to poke it',
    });
    // The room fills the view, seen from the camera's angle.
    void space.fit({ bounds: { min: [-ROOM, -ROOM, 0], max: [ROOM, ROOM, 2.4] } });
    const plot = await view(
      () => ({
        space: { plot: { x: { label: 'Time (s)' } } },
        theme: { base: 'dark', background: '#101214' },
        controls: 'inspect',
        ease: 0,
        marks: SERIES.map((s) => ({
          lines: data.table('Body'),
          trace: s.field,
          color: s.color,
          width: 2,
        })),
      }),
      { region: [0, 0.74, 1, 0.26], camera: { x: [0, WINDOW] } },
    );
    series('History', SERIES);
    const redraw = () => (space.scene = room(settings));
    const letGo = () => {
      body.release(true);
      body.endSquash();
    };

    const recording = timeline({
      data,
      keep: 20,
      replay: { seconds: 5, rate: 0.3 },
      // The plot keeps the time shown near its right edge. While a replay passes a pop, the pieces
      // stand in for the whole body.
      show(at) {
        const from = Math.max(0, at - 0.85 * WINDOW);
        plot.camera = { x: [from, from + WINDOW] };
        const was = data.get('Body', 0, 'popped', { at }) === 1;
        if (was === popped) return;
        popped = was;
        redraw();
      },
      change(now) {
        live = now;
        if (!live) letGo();
        redraw();
      },
    });

    /** Runs an action live, going live first if the timeline was replaying or paused. */
    const act = (run: () => void) => () => {
      recording.play();
      run();
    };
    actions('Actions', [
      { label: 'Hop', key: ' ', run: act(() => body.hop()) },
      {
        label: 'Squash',
        key: 's',
        run: act(() => body.squash(true)),
        release: () => body.endSquash(),
      },
      { label: 'Pop', key: 'e', run: act(() => body.pop()) },
      { label: 'Drop', key: 'd', run: act(() => body.drop()) },
    ]);
    space.on('drag', ({ phase, hit, position }) => {
      if (phase === 'start') body.grab(Number(hit.row.id), position);
      else if (phase === 'move') body.drag(position);
      else body.release();
    });
    space.on('click', ({ hit }) => act(() => body.poke(Number(hit.row.id)))());
    addEventListener('blur', letGo, { signal });

    // Each recorded frame: every vertex, the pieces while popped, a shadow under the body or under
    // each piece, and the body's height and speed.
    const vertices = body.frame();
    const chunks = burst.frame();
    const shadow = {
      x: new Float32Array(pieces + 1),
      y: new Float32Array(pieces + 1),
      radius: new Float32Array(pieces + 1),
      opacity: new Float32Array(pieces + 1),
    };
    const record = () => {
      body.sample(vertices);
      const [height, speed] = body.metrics();
      shadow.opacity.fill(0);
      if (burst.active) {
        burst.chunks.forEach(({ position: [x, y, z], radius }, i) => {
          [shadow.x[i + 1], shadow.y[i + 1]] = [x, y];
          shadow.radius[i + 1] = radius + z * 0.12;
          shadow.opacity[i + 1] = 0.32 / (1 + z);
        });
      } else {
        shadow.x[0] = vertices.x.reduce((sum, v) => sum + v, 0) / mesh.count;
        shadow.y[0] = vertices.y.reduce((sum, v) => sum + v, 0) / mesh.count;
        shadow.radius[0] = 0.85 + height * 0.15;
        shadow.opacity[0] = 0.42 / (1 + height * height * 0.4);
      }
      burst.sample(chunks, STEP);
      data
        .append('Vertex', body.time, { ...vertices })
        .append('ChunkVertex', body.time, { ...chunks })
        .append('Shadow', body.time, shadow)
        .append('Body', body.time, {
          height: [height],
          speed: [speed],
          popped: [burst.active ? 1 : 0],
        });
    };

    // A resting bunny takes no steps and records nothing, so both views sleep until something acts.
    let carry = 0;
    let next = 0;
    frame((dt) => {
      if (body.asleep) return void (carry = 0);
      carry = Math.min(carry + dt, 16 * STEP);
      const steps = body.advance(carry, WORLD);
      carry -= steps * STEP;
      if (steps && (body.time + STEP / 2 >= next || body.asleep)) {
        record();
        next = body.time + RECORD;
      }
    });
    detail(
      `${mesh.count.toLocaleString()} vertices · ${mesh.springs.a.length.toLocaleString()} springs · ${mesh.faces.a.length.toLocaleString()} faces`,
    );
    body.drop(true);
    record();
  },
});
