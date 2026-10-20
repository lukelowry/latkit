import {
  Data,
  Patch,
  colormapCss,
  field,
  type ColormapName,
  type Hit,
  type Id,
  type Scene,
} from '../latkit.js';
import { h } from '../ui/dom.js';
import { each } from '../ui/rows.js';
import type { Stage } from '../ui/stage.js';

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
  #seed = 11;
  /** The area struck by hand, and when. */
  #struck?: { area: number; at: number };

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

  /** Every signal's value at `t`, into `out`. */
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

  #random(): number {
    let t = (this.#seed = (this.#seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** How far a disturbance has pulled values, `since` seconds after it struck. */
function depth(since: number): number {
  return since < LASTS
    ? 0.06 * Math.exp(-since * 1.4) * Math.sin(Math.min(since, 0.5) * Math.PI)
    : 0;
}

export default function page(stage: Stage): void {
  let count = 2000;
  let quantity: Quantity = 'voltage';
  let window = 20;
  let rate = 50;
  let steps = false;
  let auto = true;
  let colorBy: 'area' | 'value' = 'area';
  let colormap: ColormapName = 'coolwarm';
  let width = 1;
  let signals = new Signals(count, quantity);
  let values = new Float32Array(count);
  let data = new Data('scada');
  let t = 0;
  let carry = 0;
  const shown = () => QUANTITIES[quantity];

  const scene = (): Scene => {
    const { label, unit, range, digits } = shown();
    return {
      space: {
        plot: {
          x: { label: 'Time (s)' },
          y: { label: `${label} (${unit})`, format: 'fixed', precision: digits - 1 },
        },
      },
      theme: { base: 'dark', background: '#090c11', dim: 0.15 },
      ease: 0,
      marks: [
        {
          lines: {
            of: ['scada', 'Signal'],
            trace: 'value',
            // By value, each trace takes the color of its value at the time shown.
            color:
              colorBy === 'area'
                ? field('area').colormap('tab10')
                : field('value').colormap(colormap).domain(range[0], range[1]),
            width,
            interpolation: steps ? 'stepAfter' : 'linear',
          },
        },
      ],
    };
  };
  const view = stage.view(scene(), {
    label: 'Live signals: hover a trace to read it, click it to pick it out',
  });

  /** Frames what `at` shows: the window before it, or all that is kept. */
  const frame = (at: number) => {
    const start = window === Infinity ? (data.span?.[0] ?? at) : at - window;
    const range = shown().range;
    view.camera = { x: [start, at], y: auto ? null : [range[0], range[1]] };
  };

  /** Starts the record again: `n` signals measuring the quantity shown. */
  const restart = (n = count) => {
    count = n;
    signals = new Signals(n, quantity);
    values = new Float32Array(n);
    t = 0;
    carry = 0;
    // The record starts with its first frame, so the value field is there from the start.
    signals.sample(0, values);
    data.destroy();
    data = new Data('scada').apply(
      new Patch()
        .axis('time', 's')
        .set('Signal', { count: n }, { name: signals.name, area: signals.area })
        .append(0, 'Signal', { value: values }),
    );
    view.select([]);
    view.setData(data);
    frame(0);
    detail();
    describe(null);
    hot.replaceChildren();
  };

  const playback = stage.playback({
    replay: { seconds: 10, rate: 0.25 },
    show(at) {
      view.at = at;
      frame(at);
    },
  });

  const meter = stage.meter(view);
  meter.note(() => `${((count * rate) / 1000).toFixed(0)}k samples/s`);
  let listed = 0;
  stage.frame((dt) => {
    if (performance.now() - listed > HOT_EVERY) list();
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
        patch.append(t, 'Signal', { value: values });
      }
      data.apply(patch.forget(t - HISTORY));
      view.setData(data);
      playback.record(data.span!);
    });
  });

  const readout = stage.section('Reading');
  const reading = h('p', { class: 'series' });
  readout.element.append(reading);
  const name = (id: Id) => (data.get('Signal', id, 'name') as string | null) ?? `Signal ${id}`;
  const format = (value: number) => {
    const { unit, digits } = shown();
    return `${value.toFixed(digits)} ${unit}`;
  };
  const describe = (hit: Hit | null) => {
    const picked = each(view.selection)
      .map((row) => name(row.id))
      .join(', ');
    const sample = hit?.sample;
    reading.textContent = sample
      ? `${name(hit.row.id)} at ${sample.at.toFixed(2)} s: ${format(sample.value)}`
      : picked
        ? `Picked ${picked}.`
        : 'Hover a trace.';
  };
  view.on('hover', ({ hit }) => describe(hit));
  view.on('select', () => {
    describe(null);
    list();
  });

  // The signals furthest out at the time shown, read by a query: a pick, of every signal, in
  // linear time.
  const hottest = stage.section('Hot');
  const hot = h('ol', { class: 'hot' });
  hottest.element.append(hot);
  const list = () => {
    listed = performance.now();
    if (!data.span) return;
    const { low, range } = shown();
    const rows = data.query({
      of: 'Signal',
      sort: [['value', low ? 'ascending' : 'descending']],
      limit: HOT,
      select: { name: 'name', value: 'value' },
      at: view.at,
    });
    const names = rows.fields.name as readonly string[];
    const read = rows.fields.value as Float64Array;
    const picked = new Set(each(view.selection).map((row) => String(row.id)));
    hot.replaceChildren(
      ...rows.ids.map((id, k) => {
        const value = read[k]!;
        const span = (value - range[0]) / (range[1] - range[0]);
        const score = Math.min(1, Math.max(0, low ? 1 - span : span));
        const button = h(
          'button',
          { type: 'button', 'aria-pressed': String(picked.has(String(id))) },
          h('span', {}, String(k + 1).padStart(2, '0')),
          h('span', {}, names[k] ?? `Signal ${id}`),
          h('span', {}, format(value)),
          h('span', { class: 'bar', style: `--score: ${(score * 100).toFixed(0)}%` }),
        );
        button.addEventListener('click', () => {
          view.select([{ data: 'scada', table: 'Signal', ids: [id] }]);
          describe(null);
          list();
        });
        return h('li', {}, button);
      }),
    );
  };

  const record = stage.section('Record');
  record.choice(
    'Measures',
    Object.entries(QUANTITIES).map(
      ([key, q]) => [`${q.label} (${q.unit})`, key as Quantity] as const,
    ),
    quantity,
    (next) => {
      quantity = next;
      restyle();
      restart();
    },
  );
  record.choice(
    'Signals',
    [
      ['500', 500],
      ['2,000', 2000],
      ['5,000', 5000],
    ],
    count,
    restart,
  );
  record.choice(
    'Samples',
    [
      ['20 per second', 20],
      ['50 per second', 50],
      ['100 per second', 100],
    ],
    rate,
    (r) => (rate = r),
  );
  record.actions([{ label: 'Reset', key: 'n', run: () => restart() }]);
  record.note('Measuring something else starts the record again.');

  const show = stage.section('Show');
  show.choice(
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
  show.choice(
    'Color by',
    [
      ['Area', 'area'],
      ['Value now', 'value'],
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
      if (next === width) return;
      width = next;
      view.show(scene());
    },
  );
  show.toggle('Steps', 's', steps, (on) => {
    steps = on;
    view.show(scene());
  });
  show.toggle('Auto range', 'a', auto, (on) => {
    auto = on;
    frame(view.at);
  });
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
  show.element.append(maps);
  const legend = stage.legend('top');
  const restyle = () => {
    view.show(scene());
    const { label, unit, range } = shown();
    areas.hidden = colorBy !== 'area';
    maps.hidden = legend.hidden = colorBy !== 'value';
    legend.ramp(colormap, `${label} now, ${range[0]} – ${range[1]} ${unit}`);
    for (const [map, swatch] of swatches)
      swatch.setAttribute('aria-pressed', String(map === colormap));
  };

  const disturb = stage.section('Disturb');
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
  disturb.note(`Every ${EVERY} s one area is disturbed on its own.`);

  const detail = () =>
    stage.detail(
      `${count.toLocaleString()} signals · ${shown().label.toLowerCase()} · ${HISTORY} s kept · a disturbance every ${EVERY} s`,
    );
  restyle();
  restart();
}
