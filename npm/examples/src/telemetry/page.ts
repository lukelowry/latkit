import { Data, Patch, field, type Hit, type Scene } from 'latkit';
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
/** Seconds between disturbances, and how long one lasts. */
const EVERY = 25;
const LASTS = 3;

/**
 * Synthetic SCADA voltages: each signal sits near 1 pu at its own offset, its area swings slowly,
 * every signal carries its own noise, and every `EVERY` seconds one area dips and recovers.
 */
class Signals {
  readonly area: Float64Array;
  readonly name: string[] = [];
  readonly #offset: Float32Array;
  readonly #noise: Float32Array;
  #seed = 11;

  constructor(readonly count: number) {
    this.area = new Float64Array(count);
    this.#offset = new Float32Array(count);
    this.#noise = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.area[i] = i % AREAS.length;
      this.#offset[i] = (this.#random() - 0.5) * 0.03;
      this.#noise[i] = 0.001 + this.#random() * 0.003;
      this.name.push(`${AREAS[i % AREAS.length]![0]} ${Math.floor(i / AREAS.length) + 1}`);
    }
  }

  /** Every signal's value at `t`, into `out`. */
  sample(t: number, out: Float32Array): void {
    const struck = Math.floor(t / EVERY) % AREAS.length;
    const since = t - Math.floor(t / EVERY) * EVERY;
    const dip =
      since < LASTS ? 0.06 * Math.exp(-since * 1.4) * Math.sin(Math.min(since, 0.5) * Math.PI) : 0;
    for (let i = 0; i < this.count; i++) {
      const a = this.area[i]!;
      const swing = 0.012 * Math.sin(t * (0.6 + a * 0.13) + a);
      const noise = (this.#random() - 0.5) * this.#noise[i]!;
      out[i] = 1 + this.#offset[i]! + swing + noise - (a === struck ? dip : 0);
    }
  }

  #random(): number {
    let t = (this.#seed = (this.#seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export default function page(stage: Stage): void {
  let count = 2000;
  let window = 20;
  let rate = 50;
  let steps = false;
  let signals = new Signals(count);
  let values = new Float32Array(count);
  let data = new Data('scada');
  let t = 0;
  let carry = 0;

  const scene = (): Scene => ({
    space: {
      plot: {
        x: { label: 'Time (s)' },
        y: { label: 'Voltage (pu)', format: 'fixed', precision: 2 },
      },
    },
    theme: { base: 'dark', background: '#090c11', dim: 0.15 },
    ease: 0,
    marks: [
      {
        lines: {
          of: ['scada', 'Signal'],
          trace: 'vm',
          color: field('area').colormap('tab10'),
          width: 1,
          interpolation: steps ? 'stepAfter' : 'linear',
        },
      },
    ],
  });
  const view = stage.view(scene(), {
    label: 'Live voltages: hover a trace to read it, click it to pick it out',
  });

  /** Starts the record again with `n` signals. */
  const restart = (n: number) => {
    count = n;
    signals = new Signals(n);
    values = new Float32Array(n);
    t = 0;
    carry = 0;
    data = new Data('scada').apply(
      new Patch().axis('time', 's').set('Signal', n, { name: signals.name, area: signals.area }),
    );
    view.select([]);
    view.setData(data);
    detail();
  };

  const playback = stage.playback({
    replay: { seconds: 10, rate: 0.25 },
    show(at) {
      view.at = at;
      view.camera = { x: [at - window, at], y: null };
    },
  });

  const meter = stage.meter(view);
  meter.note(() => `${((count * rate) / 1000).toFixed(0)}k samples/s`);
  stage.frame((dt) => {
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
        patch.append(t, 'Signal', { vm: values });
      }
      data = data.apply(patch.forget(t - HISTORY));
      view.setData(data);
      playback.record(data.span!);
    });
  });

  const readout = stage.section('Reading');
  const reading = document.createElement('p');
  reading.className = 'series';
  readout.element.append(reading);
  const name = (id: Hit['row']['id']) =>
    (data.get('Signal', id, 'name') as string | null) ?? `Signal ${id}`;
  const describe = (hit: Hit | null) => {
    const picked = view.selection.map((row) => name(row.id)).join(', ');
    const sample = hit?.sample;
    reading.textContent = sample
      ? `${name(hit.row.id)} at ${sample.at.toFixed(2)} s: ${sample.value.toFixed(4)} pu`
      : picked
        ? `Picked ${picked}.`
        : 'Hover a trace.';
  };
  view.on('hover', describe);
  view.on('select', () => describe(null));
  describe(null);

  const record = stage.section('Record');
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
  const show = stage.section('Show');
  show.choice(
    'Window',
    [
      ['5 s', 5],
      ['20 s', 20],
      ['60 s', 60],
    ],
    window,
    (w) => (window = w),
  );
  show.toggle('Steps', 's', steps, (on) => {
    steps = on;
    view.show(scene());
  });
  show.series(AREAS.map(([label, color]) => ({ label, color })));

  const detail = () =>
    stage.detail(
      `${count.toLocaleString()} signals · ${HISTORY} s kept · a disturbance every ${EVERY} s`,
    );
  restart(count);
}
