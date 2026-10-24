/**
 * Thousands of signals streaming in, traced over a scrolling window: frames append as they arrive
 * and the oldest are forgotten. Read the trace under the pointer, rank the largest changes with a
 * query, color traces by area or by their value now, and strike a disturbance to watch it spread.
 * Or draw a recorded day instead, fetched as time tiles a span at a time, at the detail the window
 * draws.
 */
import {
  Data,
  Patch,
  Tiles,
  colormapCss,
  field,
  type ColormapName,
  type Format,
  type Hit,
  type Id,
  type Interpolation,
  type Query,
  type Scene,
  type Snapshot,
} from 'latkit';
import { random } from '../../random.js';
import { h } from '../../ui/dom.js';
import { each } from '../../ui/rows.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';

/** The areas signals belong to, in the colors tab10 gives them. */
const AREAS = [
  ['North', '#1f77b4'],
  ['South', '#ff7f0e'],
  ['East', '#2ca02c'],
  ['West', '#d62728'],
  ['Coast', '#9467bd'],
  ['Valley', '#8c564b'],
] as const;
/** Seconds of history kept; older frames are forgotten. */
const HISTORY = 120;
/** Seconds between disturbances, and how long one lasts: long enough to have died away. */
const EVERY = 25;
const LASTS = 6;
/** Signals the hot list names, and how often it reads them again. */
const HOT = 12;
const HOT_EVERY = 250;
/** The recorded day: time tiles `scripts/history.ts` writes, of 64 buses' voltages every 15 s. */
const RECORDED = '/history/frames.json';
/** Seconds of the recorded day a second of playing shows. */
const DAY_RATE = 600;

/**
 * What the signals measure: each its unit, the range it keeps to, the digits it reads to, and
 * whether its low values are the ones to watch.
 */
const QUANTITIES = {
  voltage: { label: 'Voltage', unit: 'pu', range: [0.92, 1.04], digits: 4, low: true },
  frequency: { label: 'Frequency', unit: 'Hz', range: [59.8, 60.06], digits: 3, low: true },
  loading: { label: 'Loading', unit: '%', range: [0, 130], digits: 1, low: false },
  temperature: { label: 'Temperature', unit: '°C', range: [20, 110], digits: 1, low: false },
} as const;
type Quantity = keyof typeof QUANTITIES;
/** The colormaps a signal's value now may take. */
const MAPS: readonly ColormapName[] = ['coolwarm', 'viridis', 'turbo', 'magma', 'icefire'];
/** How often a signal reports nothing, when signals drop out. */
const DROPOUT = 0.002;

/**
 * Patches sent as bytes through a stream, as a socket or a response body brings them, each in two
 * pieces as the network splits it, and read back with `Patch.stream` as each one's last byte arrives.
 */
class Feed {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(take: (patch: Patch) => void) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.#writer = writable.getWriter();
    void (async () => {
      for await (const patch of Patch.stream(readable)) take(patch);
    })();
  }

  send(patch: Patch): void {
    const bytes = patch.toBytes();
    const half = bytes.length >> 1;
    void this.#writer.write(bytes.subarray(0, half));
    void this.#writer.write(bytes.subarray(half));
  }

  close(): void {
    void this.#writer.close();
  }
}

/**
 * Synthetic SCADA signals: each sits at its own offset, its area swings slowly, every signal
 * carries its own noise, and every `EVERY` seconds one area is disturbed and recovers, as is an
 * area struck by hand. A disturbance pulls voltages and the system's frequency down, and pushes
 * loading and temperature up.
 */
class Signals {
  readonly area: Float64Array;
  readonly name: string[] = [];
  readonly #offset: Float32Array;
  readonly #noise: Float32Array;
  readonly #random = random(11);
  /** The area struck by hand, and when. */
  #struck?: { area: number; at: number };

  /** Whether signals now and then report nothing. */
  dropouts = false;

  constructor(
    readonly count: number,
    readonly quantity: Quantity,
  ) {
    this.area = new Float64Array(count);
    this.#offset = new Float32Array(count);
    this.#noise = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.area[i] = i % AREAS.length;
      this.#offset[i] = this.#random() - 0.5;
      this.#noise[i] = 0.3 + this.#random();
      this.name.push(`${AREAS[i % AREAS.length]![0]} ${Math.floor(i / AREAS.length) + 1}`);
    }
  }

  /** Strikes area `area` at `t`: it is disturbed and recovers as the timed disturbances do. */
  strike(area: number, t: number): void {
    this.#struck = { area, at: t };
  }

  /** Every signal's value at `t`, into `out`: NaN where one reports nothing. */
  sample(t: number, out: Float32Array): void {
    const struck = Math.floor(t / EVERY) % AREAS.length;
    const dip = depth(t - Math.floor(t / EVERY) * EVERY);
    const byHand = this.#struck && t >= this.#struck.at ? depth(t - this.#struck.at) : 0;
    // The system's frequency falls with any disturbance, wherever it strikes.
    const system = 60 + 0.01 * Math.sin(t * 0.21) - 2 * Math.max(dip, byHand);
    for (let i = 0; i < this.count; i++) {
      const a = this.area[i]!;
      const swing = Math.sin(t * (0.6 + a * 0.13) + a);
      const noise = (this.#random() - 0.5) * this.#noise[i]!;
      const dips = (a === struck ? dip : 0) + (a === this.#struck?.area ? byHand : 0);
      const offset = this.#offset[i]!;
      if (this.dropouts && this.#random() < DROPOUT) {
        out[i] = NaN;
        continue;
      }
      out[i] =
        this.quantity === 'voltage'
          ? 1 + 0.03 * offset + 0.012 * swing + 0.003 * noise - dips
          : this.quantity === 'frequency'
            ? system + 0.004 * swing + 0.001 * noise
            : this.quantity === 'loading'
              ? 60 + 25 * offset + 15 * swing + 2 * noise + 600 * dips
              : 45 + 20 * offset + 8 * swing + 0.5 * noise + 400 * dips;
    }
  }
}

/** How far a disturbance has pulled values, `since` seconds after it struck. */
function depth(since: number): number {
  return since < LASTS
    ? 0.06 * Math.exp(-since * 1.4) * Math.sin(Math.min(since, 0.5) * Math.PI)
    : 0;
}

/** Second `at` of a day as a clock reads it. */
function clock(at: number): string {
  const s = Math.max(0, Math.round(at));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

export default function page(stage: Stage): void {
  let source: 'live' | 'recorded' = 'live';
  let count = 2000;
  let quantity: Quantity = 'voltage';
  let window = 20;
  let dayWindow = Infinity;
  let rate = 50;
  let interpolation: Interpolation = 'linear';
  let auto = true;
  let colorBy: 'area' | 'value' | 'plain' = 'area';
  let colormap: ColormapName = 'coolwarm';
  let width = 1;
  const axes = { format: 'fixed' as Format, grid: true, limits: false, time: true, title: false };
  let dim = 0.15;
  let playhead = '#ffb000cc';
  let streamed = false;
  let dropouts = false;
  let signals = new Signals(count, quantity);
  let values = new Float32Array(count);
  let data = new Data('scada');
  /** The span of the recorded day that landed. */
  let day: [number, number] | undefined;
  let t = 0;
  let carry = 0;
  const shown = () => QUANTITIES[quantity];

  const scene = (): Scene => {
    const { label, unit, range, digits } = shown();
    const middle = (range[0] + range[1]) / 2;
    return {
      space: {
        plot: {
          x: { label: 'Time (s)', grid: axes.grid, hidden: !axes.time },
          y: {
            label: `${label} (${unit})`,
            format: axes.format,
            precision: axes.format === 'auto' ? null : digits - 1,
            grid: axes.grid,
            // The range a signal keeps to, ticked at its ends and its middle.
            ...(axes.limits
              ? {
                  ticks: [
                    [range[0], 'low'],
                    [middle, null],
                    [range[1], 'high'],
                  ] as const,
                }
              : {}),
          },
        },
      },
      ...(axes.title
        ? {
            title: `${label} ${source === 'live' ? 'live' : 'over a recorded day'}`,
            subtitle:
              source === 'live'
                ? `${count.toLocaleString()} signals · ${rate} samples a second`
                : '64 buses · a sample every 15 s',
          }
        : {}),
      // Traces draw the theme's line width, and plain, its line color; what a signal does not report
      // reads as missing.
      theme: {
        ...theme,
        focus: { dim },
        plot: { playhead },
        line: { color: '#7fb3ff', width },
        missing: '#ff4fd8',
      },
      ease: 0,
      marks: [
        {
          lines: {
            of: ['scada', 'Signal'],
            trace: 'value',
            // By value, each trace takes the color of its value at the time shown.
            ...(colorBy === 'plain'
              ? {}
              : {
                  color:
                    colorBy === 'area'
                      ? field('area').colormap('tab10')
                      : field('value').colormap(colormap).domain(range[0], range[1]),
                }),
            interpolation,
          },
        },
      ],
    };
  };
  const view = stage.view(scene(), {
    label: 'Live signals: hover a trace to read it, click it to pick it out',
  });

  /**
   * `f` of what the view draws of the signals now: the live record, or what it fetched of the
   * recorded day; `undefined` before it has any.
   */
  const read = <T>(f: (held: Data | Snapshot) => T): T | undefined => {
    if (source === 'live') return f(data);
    const held = view.snapshot('scada');
    if (!held) return undefined;
    try {
      return f(held);
    } finally {
      held.destroy();
    }
  };

  /** Frames what `at` shows: the window before it, filling from the record's start until the
   * record is as long; or all that is kept. */
  const frame = (at: number) => {
    const first = read((held) => held.describe().span?.[0]) ?? at;
    const span = source === 'live' ? window : dayWindow;
    const x: [number, number] =
      span === Infinity
        ? [first, Math.max(at, first + 1)]
        : [Math.max(first, at - span), Math.max(at, first + span)];
    const range = shown().range;
    view.camera = { x, y: auto ? null : [range[0], range[1]] };
  };

  /** Takes a patch the feed brought: the record grows, and the view draws it the next frame. */
  const take = (patch: Patch) => {
    data.apply(patch);
    playback.record(data.describe().span!);
  };
  /** The stream patches come through when they come as bytes, made again with each record. */
  let feed: Feed | undefined;
  stage.signal.addEventListener('abort', () => feed?.close());

  /** Draws the source chosen: a live record started again, of `n` signals measuring the quantity
   * shown; or the recorded day, drawn as the tiles of it the window asks for land. */
  const restart = (n = count) => {
    count = n;
    // Patches of the record before arrive no more.
    feed?.close();
    feed = undefined;
    data.destroy();
    view.selection = [];
    hot.replaceChildren();
    for (const section of [feedSection, disturb]) section.element.hidden = source === 'recorded';
    liveWindows.parentElement!.hidden = source === 'recorded';
    dayWindows.parentElement!.hidden = source === 'live';
    if (source === 'recorded') {
      day = undefined;
      quantity = 'voltage';
      measure.value = String(Object.keys(QUANTITIES).indexOf(quantity));
      data = new Data('scada');
      view.sources = [new Tiles('scada', RECORDED)];
      playback.live = false;
      playback.rate = DAY_RATE;
      restyle();
      detail();
      describe(null);
      return;
    }
    signals = new Signals(n, quantity);
    signals.dropouts = dropouts;
    values = new Float32Array(n);
    t = 0;
    carry = 0;
    // The record starts with its first frame, so the value field is there from the start.
    signals.sample(0, values);
    data = new Data('scada').apply(
      new Patch()
        .axis('time', 's')
        .set('Signal', { count: n }, { name: signals.name, area: signals.area })
        .append('Signal', 0, { value: values }),
    );
    view.sources = [data];
    const current = data;
    feed = new Feed((patch) => data === current && take(patch));
    playback.rate = 1;
    playback.live = true;
    restyle();
    frame(0);
    detail();
    describe(null);
  };

  const playback = stage.playback({
    replay: { seconds: 10, rate: 0.25 },
    show(at) {
      view.at = at;
      frame(at);
    },
    format: (at) => (source === 'live' ? `${at.toFixed(2)} s` : clock(at)),
  });

  const meter = stage.meter(view);
  meter.note(() =>
    source === 'live' ? `${((count * rate) / 1000).toFixed(0)}k samples/s` : 'tiles of a day',
  );
  let listed = 0;
  let spanned = 0;
  stage.frame((dt) => {
    if (performance.now() - listed > HOT_EVERY) list();
    // The recorded day spans what of it landed, growing as its spans do: until the transport is
    // moved, it shows to the end.
    if (source === 'recorded' && performance.now() - spanned > HOT_EVERY) {
      spanned = performance.now();
      const span = read((held) => held.describe().span);
      if (span && (span[0] !== day?.[0] || span[1] !== day?.[1])) {
        const end = !day || playback.at >= day[1];
        day = span;
        playback.record(span);
        if (end) playback.seek(span[1]);
      }
    }
    if (playback.mode !== 'live') return;
    meter.measure('append', () => {
      carry += dt * rate;
      const frames = Math.floor(carry);
      if (!frames) return;
      carry -= frames;
      const patch = new Patch();
      for (let k = 0; k < frames; k++) {
        t += 1 / rate;
        signals.sample(t, values);
        patch.append('Signal', t, { value: values });
      }
      patch.forget(t - HISTORY);
      if (streamed) feed!.send(patch);
      else take(patch);
    });
  });

  const readout = stage.section('Reading');
  const reading = h('p', { class: 'series' });
  readout.content.append(reading);
  const name = (id: Id) =>
    (read((held) => held.get('Signal', id, 'name')) as string | null | undefined) ?? `Signal ${id}`;
  const format = (value: number) => {
    const { unit, digits } = shown();
    return `${value.toFixed(digits)} ${unit}`;
  };
  const when = (at: number) => (source === 'live' ? `${at.toFixed(2)} s` : clock(at));
  /** Signal `id`'s least and greatest values over the window shown, read from its levels of detail. */
  const spread = (id: Id) => {
    const camera = view.camera;
    if (!('x' in camera)) return '';
    const envelope = read((held) =>
      held.describe().span
        ? held.envelope({ table: 'Signal', field: 'value', range: camera.x, spans: 1, ids: [id] })
        : undefined,
    );
    if (!envelope || Number.isNaN(envelope.least[0])) return '';
    return `; ${format(envelope.least[0]!)} to ${format(envelope.greatest[0]!)} in the window`;
  };
  const describe = (hit: Hit | null) => {
    const picked = each(view.selection)
      .map((row) => name(row.id))
      .join(', ');
    const sample = hit?.sample;
    reading.textContent = sample
      ? `${name(hit.row.id)} at ${when(sample.at)}: ${format(sample.value)}${spread(hit.row.id)}`
      : picked
        ? `Picked ${picked}.`
        : 'Hover a trace.';
  };
  view.on('hovered', ({ hit }) => describe(hit));
  view.on('selection', () => {
    describe(null);
    list();
  });

  // The signals furthest out at the time shown, read by a query: a pick, of every signal or of an
  // area's, in linear time, a page of them at a time.
  const hottest = stage.section('Largest changes', false);
  let inArea = -1;
  let page = 0;
  hottest.choice(
    'Area',
    [['All', -1] as const, ...AREAS.map(([label], i) => [label, i] as const)],
    inArea,
    (next) => {
      inArea = next;
      page = 0;
      list();
    },
  );
  const turn = (by: number) => () => {
    page = Math.max(0, page + by);
    list();
  };
  hottest.actions([
    { label: 'Previous', run: turn(-1) },
    { label: 'Next', run: turn(1) },
  ]);
  const paged = hottest.note();
  const hot = h('ol', { class: 'hot' });
  hottest.content.append(hot);
  const list = () => {
    listed = performance.now();
    const { low, range } = shown();
    const query: Query = {
      of: 'Signal',
      ...(inArea >= 0 ? { filter: field('area').eq(inArea) } : {}),
      sort: [['value', low ? 'ascending' : 'descending']],
      limit: HOT,
      select: { name: 'name', value: 'value' },
      at: view.at,
    };
    const found = read((held) => {
      if (!held.describe().span) return undefined;
      let rows = held.query({ ...query, offset: page * HOT });
      // Past the last page, the last.
      if (!rows.ids.length && page > 0) {
        page = Math.max(0, Math.ceil(rows.total / HOT) - 1);
        rows = held.query({ ...query, offset: page * HOT });
      }
      return rows;
    });
    if (!found) return;
    paged.textContent = found.total
      ? `${page * HOT + 1}–${page * HOT + found.ids.length} of ${found.total.toLocaleString()}`
      : 'None';
    const names = found.fields.name as readonly string[];
    const readings = found.fields.value as Float64Array;
    const picked = new Set(each(view.selection).map((row) => String(row.id)));
    hot.replaceChildren(
      ...found.ids.map((id, k) => {
        const value = readings[k]!;
        const span = (value - range[0]) / (range[1] - range[0]);
        const score = Math.min(1, Math.max(0, low ? 1 - span : span));
        const button = h(
          'button',
          { type: 'button', 'aria-pressed': String(picked.has(String(id))) },
          h('span', {}, String(page * HOT + k + 1).padStart(2, '0')),
          h('span', {}, names[k] ?? `Signal ${id}`),
          h('span', {}, format(value)),
          h('span', { class: 'bar', style: `--score: ${(score * 100).toFixed(0)}%` }),
        );
        button.addEventListener('click', () => {
          view.selection = [{ data: 'scada', table: 'Signal', ids: [id] }];
          describe(null);
          list();
        });
        return h('li', {}, button);
      }),
    );
  };

  const record = stage.section('Data');
  record.choice(
    'Source',
    [
      ['Live feed', 'live'],
      ['Recorded day', 'recorded'],
    ] as const,
    source,
    (next) => {
      source = next;
      restart();
    },
  );
  const feedSection = stage.section('Live feed');
  feedSection.note('Simulated data');
  const measure = feedSection.choice(
    'Measure',
    Object.entries(QUANTITIES).map(
      ([key, q]) => [`${q.label} (${q.unit})`, key as Quantity] as const,
    ),
    quantity,
    (next) => {
      quantity = next;
      restart();
    },
  );
  feedSection.choice(
    'Signals',
    [
      ['500', 500],
      ['2,000', 2000],
      ['5,000', 5000],
    ],
    count,
    restart,
  );
  feedSection.choice(
    'Samples',
    [
      ['20 per second', 20],
      ['50 per second', 50],
      ['100 per second', 100],
    ],
    rate,
    (r) => {
      rate = r;
      restyle();
    },
  );
  feedSection.choice(
    'Feed',
    [
      ['In the page', false],
      ['Streamed bytes', true],
    ] as const,
    streamed,
    (next) => (streamed = next),
  );
  feedSection.toggle('Dropouts', 'o', dropouts, (on) => {
    dropouts = on;
    signals.dropouts = on;
  });
  feedSection.actions([{ label: 'Reset', key: 'n', run: () => restart() }]);

  const show = stage.section('Display');
  const liveWindows = show.choice(
    'Window',
    [
      ['5 s', 5],
      ['20 s', 20],
      ['60 s', 60],
      [`All ${HISTORY} s kept`, Infinity],
    ],
    window,
    (w) => {
      window = w;
      frame(view.at);
    },
  );
  const dayWindows = show.choice(
    'Window',
    [
      ['10 minutes', 600],
      ['An hour', 3600],
      ['Six hours', 6 * 3600],
      ['The day', Infinity],
    ],
    dayWindow,
    (w) => {
      dayWindow = w;
      frame(view.at);
    },
  );
  show.choice(
    'Color by',
    [
      ['Area', 'area'],
      ['Value now', 'value'],
      ['Plain', 'plain'],
    ] as const,
    colorBy,
    (next) => {
      colorBy = next;
      restyle();
    },
  );
  show.range(
    'Width',
    { min: 0.5, max: 3, step: 0.5, value: width, format: (v) => `${v} px` },
    (next) => {
      width = next;
      view.scene = scene();
    },
  );
  show.choice(
    'Between samples',
    [
      ['Lines', 'linear'],
      ['Steps after', 'stepAfter'],
      ['Steps before', 'stepBefore'],
    ] as const,
    interpolation,
    (next) => {
      interpolation = next;
      view.scene = scene();
    },
  );
  show.range(
    'Dim the rest',
    { min: 0, max: 1, step: 0.05, value: dim, format: (v) => `${Math.round(v * 100)}%` },
    (next) => {
      dim = next;
      view.scene = scene();
    },
  );
  show.choice(
    'Playhead',
    [
      ['Amber', '#ffb000cc'],
      ['White', '#ffffffaa'],
      ['Hidden', '#00000000'],
    ] as const,
    playhead,
    (next) => {
      playhead = next;
      view.scene = scene();
    },
  );
  show.toggle('Auto range', 'a', auto, (on) => {
    auto = on;
    frame(view.at);
  });
  show.toggle('Title', undefined, axes.title, (on) => ((axes.title = on), (view.scene = scene())));
  const axesSection = stage.section('Axes', false);
  axesSection.choice(
    'Values',
    [
      ['Fixed', 'fixed'],
      ['Automatic', 'auto'],
      ['Scientific', 'scientific'],
      ['Engineering', 'engineering'],
    ] as const,
    axes.format,
    (format) => ((axes.format = format), (view.scene = scene())),
  );
  axesSection.toggle('Grid', 'g', axes.grid, (on) => ((axes.grid = on), (view.scene = scene())));
  axesSection.toggle(
    'Limits',
    'l',
    axes.limits,
    (on) => ((axes.limits = on), (view.scene = scene())),
  );
  axesSection.toggle(
    'Time axis',
    undefined,
    axes.time,
    (on) => ((axes.time = on), (view.scene = scene())),
  );
  const areas = show.series(AREAS.map(([label, color]) => ({ label, color })));
  const maps = h('div', { class: 'swatches' });
  const swatches = MAPS.map((map) => {
    const swatch = h(
      'button',
      { type: 'button', class: 'swatch', 'aria-pressed': String(map === colormap) },
      h('span', { class: 'ramp', style: `background: ${colormapCss(map)}` }),
      map,
    );
    swatch.addEventListener('click', () => {
      colormap = map;
      restyle();
    });
    maps.append(swatch);
    return [map, swatch] as const;
  });
  show.content.append(maps);
  const legend = stage.legend('top');
  const restyle = () => {
    view.scene = scene();
    const { label, unit, range } = shown();
    areas.hidden = colorBy !== 'area';
    maps.hidden = legend.hidden = colorBy !== 'value';
    legend.ramp(colormap, `${label} now, ${range[0]} – ${range[1]} ${unit}`);
    for (const [map, swatch] of swatches)
      swatch.setAttribute('aria-pressed', String(map === colormap));
  };

  const disturb = stage.section('Disturbance');
  let target = 0;
  disturb.choice(
    'Area',
    AREAS.map(([label], i) => [label, i] as const),
    target,
    (next) => (target = next),
  );
  disturb.actions([
    {
      label: 'Strike it now',
      key: 'd',
      run: () => {
        signals.strike(target, t);
        if (playback.mode !== 'live') playback.play();
      },
    },
  ]);
  disturb.note(`Auto disturbance: every ${EVERY} s`);

  const detail = () =>
    stage.detail(
      source === 'live'
        ? `${count.toLocaleString()} signals · ${shown().label.toLowerCase()} · ${HISTORY} s kept`
        : '64 buses · voltage · a recorded day, fetched as the window draws it',
    );
  restart();
}
