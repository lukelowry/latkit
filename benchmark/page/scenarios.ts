/**
 * Every scenario: what it sweeps, the scene and data at each size, and what it does. Each phase
 * declares how its cost may grow with size, so the sweep checks the README's rules: CPU per frame
 * stays flat in the rows, a one-row change costs the same at any size, restyling moves no data,
 * views share pages, coming back where the camera was costs nothing, appending never thins what
 * draws, and loading grows no faster than the data. `init`, `data`, and `load` come
 * first in every scenario, and idle frames are counted after the last.
 */
import { field, type Budget, type Camera, type ColormapName, type Scene, type Space } from 'latkit';
import * as make from './data.ts';
import { deadline, type Cost, type Stage, type Write } from './stage.ts';

export interface Scenario {
  /** What it stresses. */
  about: string;
  /** What a size counts, and the sizes swept, smallest first; `--quick` runs the smallest. */
  unit: string;
  sizes: readonly number[];
  build(size: number): Built;
  phases: readonly Phase[];
  /** How `load` may grow; with the data, in time and bytes, unless set. */
  load?: Order;
  /** Views of one GPU drawing the scene; one unless set. */
  views?(size: number): number;
  /** The GPU's budget, where the scenario is about it. */
  budget?: Budget;
  /** Run in a fresh browser without a shader cache: what a first visit costs. */
  cold?: boolean;
  /** Its data is fetched as the camera asks, so what it uploads moves with the frame a fetch lands in. */
  fetches?: boolean;
}

export interface Built {
  scene: Scene;
  /** Each dataset, made beforehand, so `data` times latkit alone. */
  data: Record<string, Write>;
  /** Vector tiles by dataset name: URL templates the bench server answers. */
  tiles?: Record<string, string>;
  /** Where the view looks; it fits everything unless set. */
  camera?: Camera;
}

/**
 * How a phase's cost may grow with size: 0 not at all, 1 no faster than linearly. `time` is a steady
 * phase's CPU per frame or an action's milliseconds; `bytes` is what it uploaded and what stays
 * resident. A measure left out is held only to the baselines.
 */
export interface Order {
  time?: 0 | 1;
  bytes?: 0 | 1;
}

export interface Phase {
  name: string;
  order: Order;
  run(stage: Stage): Promise<Cost>;
}

export const LOAD: Order = { time: 1, bytes: 1 };
export const DECADES = [1e3, 1e4, 1e5, 1e6, 2e6];
/** Frames a steady phase acts in: past its warm-up, enough for a steady median, and no more. */
export const FRAMES = 40;
export const HISTORY = 1024;
type MapCamera = Extract<Camera, { center: unknown }>;

// Scenes.

/** Dataset `d`'s points, colored by `v` through `colormap`, labeled by `label` when given. */
const dots = (space: Space, colormap: ColormapName = 'viridis', label?: string): Scene => ({
  space,
  ease: 0,
  marks: [
    {
      vertices: {
        of: ['d', 'Point'],
        position: ['x', 'y'],
        color: field('v').colormap(colormap).domain(0, 1),
        ...(label ? { label: field(label) } : {}),
      },
    },
  ],
});

/** Dataset `g`'s buses, colored by load, and the lines between them. */
const grid = (space: Space): Scene => ({
  space,
  ease: 0,
  marks: [
    { edges: { of: ['g', 'Line'], ends: ['from', 'to'], width: 0.6 } },
    {
      vertices: {
        of: ['g', 'Bus'],
        position: ['lon', 'lat'],
        color: field('load').colormap('viridis').domain(0, 1),
      },
    },
  ],
});

const plot: Scene = {
  space: 'plot',
  ease: 0,
  marks: [{ lines: { of: ['t', 'Signal'], trace: 'v' } }],
};

const sheet: Scene = {
  space: 'diagram',
  ease: 0,
  layout: { layered: { flow: 'right' } },
  marks: [
    { edges: { of: ['d', 'Net'], route: 'orthogonal' } },
    {
      vertices: {
        of: ['d', 'Block'],
        marker: 'block',
        label: { text: 'name' },
        ports: [
          ['in', 'left'],
          ['out', { side: 'right', output: true }],
        ],
      },
    },
  ],
};

// Phases.

/** Pans and zooms gently about where the views looked, a frame at a time, back to where it began. */
const pan = (order: Order = { time: 0 }): Phase => ({
  name: 'pan',
  order,
  run: (s) => {
    const start = s.view.camera as MapCamera;
    const reach = s.across(200);
    return s.steady(FRAMES, (i) => {
      const t = (2 * Math.PI * i) / FRAMES;
      const center: [number, number] = [
        start.center[0] + reach * Math.sin(t),
        start.center[1] + 0.5 * reach * Math.sin(2 * t),
      ];
      for (const v of s.views)
        v.camera = { ...start, center, zoom: start.zoom + 0.3 * Math.sin(2 * t) };
    });
  },
});

/** Zooms two levels in and back: labels give way, tiles refine. */
const zoom = (): Phase => ({
  name: 'zoom',
  order: { time: 0 },
  run: (s) => {
    const start = s.view.camera as MapCamera;
    return s.steady(FRAMES, (i) => {
      for (const v of s.views)
        v.camera = { ...start, zoom: start.zoom + 2 * Math.sin((Math.PI * i) / FRAMES) };
    });
  },
});

/** Zooms two levels in, then back where it was: measured, the way back, which draws the pages it held
 * and so packs, uploads, and evaluates nothing. */
const revisit = (): Phase => ({
  name: 'revisit',
  order: { time: 0, bytes: 0 },
  run: async (s) => {
    const start = s.view.camera as MapCamera;
    await s.once(() => {
      for (const v of s.views) v.camera = { ...start, zoom: start.zoom + 2 };
    });
    return s.once(() => {
      for (const v of s.views) v.camera = start;
    });
  },
});

/** Recolors through `scene`'s colormap: the GPU evaluates again; no data moves. */
const restyle = (scene: Scene): Phase => ({
  name: 'restyle',
  order: { bytes: 0 },
  run: (s) => s.once(() => s.show(scene)),
});

/** Changes one row's value every frame: what one row costs at any size. */
const one = (data: string, table: string, name: string): Phase => ({
  name: 'one row',
  order: { time: 0, bytes: 0 },
  run: (s) =>
    s.steady(FRAMES, (i) => s.apply(data, (p) => p.set(table, [i], { [name]: [(i % 10) / 10] }))),
});

/** Appends a row to `table` every frame, as a feed of new rows does: what draws never thins. */
const append = (
  data: string,
  table: string,
  row: (i: number) => Record<string, number[]>,
): Phase => ({
  name: 'append',
  order: { time: 0 },
  run: async (s) => {
    const n = s.count(data, table);
    const drawn = () => s.views.map((v) => v.stats.drawn);
    const start = drawn();
    let thinned = '';
    const cost = await s.steady(FRAMES, (i) => {
      const now = drawn();
      if (!thinned && now.some((d, v) => d < start[v]!))
        thinned = `${now.join(', ')} drawn, ${start.join(', ')} before`;
      s.apply(data, (p) => p.set(table, [n + i], row(i)));
    });
    if (thinned) throw new Error(`appending thinned what draws: ${thinned}`);
    return cost;
  },
});

/** Changes every row's value at once. */
const every = (data: string, table: string, name: string): Phase => ({
  name: 'every row',
  order: { time: 1, bytes: 1 },
  run: (s) => {
    const n = s.count(data, table);
    const values = Float32Array.from({ length: n }, (_, i) => (i % 7) / 7);
    return s.once(() => s.apply(data, (p) => p.set(table, { count: n }, { [name]: values })));
  },
});

/** Asks what lies under the middle, as a click does: how long the answer takes. The first ask in a
 * page makes the query's pipelines; later asks reuse them. */
const pick = (): Phase[] => [
  {
    name: 'first pick',
    order: { time: 0, bytes: 0 },
    run: (s) => s.once(() => s.view.pick(s.middle, 6)),
  },
  {
    name: 'pick',
    order: { time: 0, bytes: 0 },
    run: (s) => s.once(() => s.view.pick(s.middle, 6)),
  },
];

/** Moves the pointer onto a row near the middle and waits for the view to name it. */
const hover = (): Phase => ({
  name: 'hover',
  order: { time: 0, bytes: 0 },
  run: async (s) => {
    const [hit] = await deadline(s.until(s.view.pick(s.middle, 40)), 10_000, 'a row to hover');
    if (!hit) {
      const seen = { middle: s.middle, camera: s.view.camera, stats: s.view.stats };
      throw new Error(`nothing near the middle to hover: ${JSON.stringify(seen)}`);
    }
    const told: unknown[] = [];
    try {
      return await s.once(
        () =>
          new Promise<void>((resolve) => {
            const stop = s.view.on('hover', ({ hit: h }) => {
              told.push(h?.row ?? null);
              if (!h) return;
              stop();
              resolve();
            });
            s.pointer('pointermove', hit.point);
          }),
      );
    } catch (error) {
      const seen = {
        at: hit.point,
        hit: hit.row,
        told,
        camera: s.view.camera,
        stats: s.view.stats,
      };
      throw new Error(`${String(error)}; ${JSON.stringify(seen)}`, { cause: error });
    }
  },
});

/** Selects a hundred rows: the glow, and what dims; a table drawn through tiles keeps them drawn. */
const select = (data: string, table: string): Phase => ({
  name: 'select',
  order: { time: 0 },
  run: (s) =>
    s.once(() => s.view.select([{ data, table, ids: Array.from({ length: 100 }, (_, id) => id) }])),
});

/** Moves every row to a new place at once, easing: CPU per frame while they fly. */
const move = (): Phase => ({
  name: 'move',
  order: { time: 0, bytes: 1 },
  run: (s) => {
    const next = make.scatter(s.size, 2);
    return s.steady(FRAMES, (i) => i === 0 && s.apply('d', next));
  },
});

/** Records a frame of every trace each animation frame, as a live feed does, forgetting the oldest. */
const stream = (): Phase => ({
  name: 'stream',
  order: { time: 1, bytes: 1 },
  run: (s) => {
    const feed = make.feed(s.size, HISTORY, FRAMES, HISTORY);
    return s.steady(FRAMES, (i) => s.apply('t', feed[i]!));
  },
});

/** Moves the coordinate shown across what was recorded: the playhead, and colors read at it. */
const scrub = (): Phase => ({
  name: 'scrub',
  order: { time: 0, bytes: 0 },
  run: (s) => {
    const [a, b] = s.span('t');
    return s.steady(FRAMES, (i) => {
      for (const v of s.views) v.at = a + ((b - a) * i) / FRAMES;
    });
  },
});

/** Narrows the window shown from everything to its last tenth: levels of detail give way, each
 * trace's finer one uploading as it first draws. */
const narrow = (order: Order = { time: 0, bytes: 0 }): Phase => ({
  name: 'narrow',
  order,
  run: (s) => {
    const [a, b] = s.span('t');
    return s.steady(FRAMES, (i) => {
      for (const v of s.views) v.camera = { x: [a + ((b - a) * 0.9 * i) / FRAMES, b], y: null };
    });
  },
});

/** Renames a block every frame, so it resizes and its tree routes again: an edit at any size. */
const edit = (): Phase => ({
  name: 'edit',
  order: { time: 0, bytes: 0 },
  run: (s) =>
    s.steady(FRAMES, (i) =>
      s.apply('d', (p) => p.set('Block', [1 + (i % 63)], { name: [`Renamed block ${i}`] })),
    ),
});

/** Lays every block out again. */
const arrange = (): Phase => ({
  name: 'arrange',
  order: { time: 1 },
  run: (s) => s.once(() => s.view.arrange()),
});

/** A shot of every view side by side, the scenario's size in pixels, at 16:9. */
function shot(s: Stage) {
  const width = Math.round(Math.sqrt((s.size * 16) / 9) / 4) * 4;
  const height = Math.round((width * 9) / 16 / 2) * 2;
  const n = s.views.length;
  return new s.latkit.Shot([width, height]).panels(s.views.map((_, i) => [i / n, 0, 1 / n, 1]));
}

const image = (): Phase => ({
  name: 'image',
  order: { time: 1 },
  run: (s) => s.once(() => shot(s).image(s.views)),
});

const png = (): Phase => ({
  name: 'png',
  order: { time: 1 },
  run: async (s) => {
    const picture = await deadline(shot(s).image(s.views), 60_000, 'a picture');
    return s.once(() => picture.encode('png'));
  },
});

/** Thirty frames of video, turning; held, nothing moves, so frames after the first cost nothing. */
const video = (moving: boolean): Phase => ({
  name: moving ? 'video' : 'held',
  order: moving ? { time: 1 } : {},
  run: (s) => {
    const start = s.view.camera as MapCamera;
    return s.once(async () => {
      const video = shot(s).video(s.gpu, 30, new WritableStream<Uint8Array>());
      for (let i = 0; i < 30; i++) {
        if (moving)
          for (const v of s.views) v.camera = { ...start, bearing: start.bearing + 2 * i };
        await video.frame(s.views);
      }
      await video.finish();
    });
  },
});

// Scenarios.

export const scenarios: Record<string, Scenario> = {
  start: {
    about: 'a first visit: latkit, the GPU, and pipelines made without a shader cache',
    unit: 'rows',
    sizes: [1e4],
    cold: true,
    build: (n) => ({ scene: dots('plane'), data: { d: make.scatter(n) } }),
    phases: [],
  },
  points: {
    about: 'vertices on a plane, colored through a colormap',
    unit: 'rows',
    sizes: DECADES,
    build: (n) => ({ scene: dots('plane'), data: { d: make.scatter(n) } }),
    phases: [
      pan(),
      zoom(),
      revisit(),
      restyle(dots('plane', 'magma')),
      one('d', 'Point', 'v'),
      every('d', 'Point', 'v'),
      ...pick(),
      hover(),
      select('d', 'Point'),
      append('d', 'Point', (i) => ({
        x: [((i * 37) % 100) / 100],
        y: [((i * 53) % 100) / 100],
        v: [0.5],
      })),
    ],
  },
  grid: {
    about: 'a lattice grid on the globe: buses, and the geodesic lines between them',
    unit: 'buses',
    sizes: DECADES,
    build: (n) => ({
      scene: grid({ earth: { projection: 'globe' } }),
      data: { g: make.lattice(n) },
    }),
    phases: [
      pan(),
      zoom(),
      revisit(),
      one('g', 'Bus', 'load'),
      ...pick(),
      hover(),
      append('g', 'Bus', (i) => ({
        lon: [-170 + (340 * ((i * 37) % 100)) / 100],
        lat: [-60 + (120 * ((i * 53) % 100)) / 100],
        load: [0.5],
      })),
    ],
  },
  labels: {
    about: 'every vertex labeled: placement, collisions, and the texts set',
    unit: 'rows',
    // From ten thousand rows on, more labels show than a frame sets texts for, so a frame's CPU
    // holds at the text budget however many rows are labeled.
    sizes: [1e4, 1e5, 1e6],
    build: (n) => ({
      scene: dots('plane', 'viridis', 'name'),
      data: { d: make.scatter(n, 1, true) },
    }),
    phases: [pan(), zoom()],
  },
  lanes: {
    about: 'edges by the thousand between the same sixteen pairs of vertices',
    unit: 'edges',
    sizes: [1e2, 1e3, 1e4, 1e5],
    build: (n) => ({
      scene: {
        space: 'plane',
        ease: 0,
        marks: [
          { edges: { of: ['d', 'Link'], ends: ['from', 'to'] } },
          { vertices: { of: ['d', 'Point'], position: ['x', 'y'] } },
        ],
      },
      data: { d: make.lanes(n) },
    }),
    phases: [pan(), ...pick()],
  },
  areas: {
    about: 'polygons of 33 points on the mercator map, triangulated in jobs',
    unit: 'polygons',
    sizes: [1e2, 1e3, 1e4, 3e4],
    build: (n) => ({
      scene: {
        space: 'mercator',
        ease: 0,
        marks: [
          {
            areas: {
              of: ['m', 'Region'],
              geometry: 'rings',
              color: field('v').colormap('viridis').domain(0, 1),
            },
          },
        ],
      },
      data: { m: make.polygons(n) },
    }),
    phases: [pan(), zoom(), one('m', 'Region', 'v'), ...pick()],
  },
  tiles: {
    about: 'vector tiles fetched as the camera asks for them, from a local server',
    unit: 'squares a tile',
    sizes: [16, 256, 4096],
    fetches: true,
    build: (n) => ({
      scene: {
        space: 'mercator',
        ease: 0,
        marks: [{ areas: { of: ['t', 'cells'], color: '#4a7fb5' } }],
      },
      data: {},
      tiles: { t: `${location.origin}/tiles/${n}/{z}/{x}/{y}.mvt` },
      camera: { center: [0, 20], zoom: 3, pitch: 0, bearing: 0 },
    }),
    phases: [pan(), zoom()],
  },
  diagram: {
    about: 'blocks with ports in trees of 64, laid out in layers, wires routed around them',
    unit: 'blocks',
    sizes: [1e2, 1e3, 1e4],
    build: (n) => ({ scene: sheet, data: { d: make.blocks(n) } }),
    phases: [pan(), edit(), arrange()],
  },
  traces: {
    about: 'a plot of traces 1,024 frames long, fed a frame every animation frame',
    unit: 'traces',
    sizes: [10, 1e2, 1e3, 1e4],
    build: (n) => ({ scene: plot, data: { t: make.traces(n, HISTORY) } }),
    // Every trace narrowed uploads its finer level.
    phases: [stream(), scrub(), narrow({ time: 0, bytes: 1 }), hover()],
  },
  history: {
    about: 'one trace with a long history: levels of detail',
    unit: 'frames',
    sizes: [1e3, 1e4, 1e5, 1e6],
    build: (n) => ({ scene: plot, data: { t: make.traces(1, n) } }),
    phases: [scrub(), narrow()],
  },
  transition: {
    about: 'every row moving to a new place at once, easing over a second',
    unit: 'rows',
    sizes: [1e3, 1e4, 1e5, 1e6],
    build: (n) => ({ scene: { ...dots('plane'), ease: 1 }, data: { d: make.scatter(n) } }),
    phases: [move()],
  },
  views: {
    about: 'views of one GPU drawing one dataset: pages shared, not copied',
    unit: 'views',
    sizes: [1, 2, 4, 8],
    views: (n) => n,
    // Room for eight views' own rows, which the views' shares of a budget hold together, so the
    // bytes that grow would be pages copied.
    budget: { bytes: 1024 * 2 ** 20, uploadPerFrame: 32 * 2 ** 20 },
    load: { time: 1, bytes: 0 },
    build: () => ({ scene: grid('plane'), data: { g: make.lattice(1e5) } }),
    phases: [pan({ time: 1, bytes: 0 })],
  },
  budget: {
    about: 'a 16 MiB budget: what draws fits, through tiles, and nothing fails',
    unit: 'buses',
    sizes: [1e5, 1e6, 2e6],
    budget: { bytes: 16 * 2 ** 20, uploadPerFrame: 4 * 2 ** 20 },
    load: { time: 1 },
    build: (n) => ({ scene: grid('plane'), data: { g: make.lattice(n) } }),
    phases: [pan(), zoom()],
  },
  shots: {
    about: 'pictures and video of two views of a 100,000-bus grid',
    unit: 'pixels',
    sizes: [960 * 540, 1920 * 1080, 3840 * 2160],
    views: () => 2,
    build: () => ({ scene: grid('plane'), data: { g: make.lattice(1e5) } }),
    phases: [image(), png(), video(true), video(false)],
  },
};
