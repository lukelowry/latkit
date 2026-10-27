/**
 * Telemetry: thousands of streaming voltages traced over a scrolling window. Frames are appended as
 * they arrive and the oldest are forgotten; pause or scrub the timeline to read back what passed.
 * Every 20 seconds one area dips and recovers, or strike one yourself, and query for the signals
 * hit hardest. Or draw a recorded day instead, fetched span by span as time tiles at the detail the
 * plot needs.
 */
import { Data, Tiles, field, selected, when, type CustomColormap } from 'latkit';
import { choice, page } from '../shell/page.js';
import { random } from '../random.js';

const AREAS = ['North', 'South', 'East', 'West', 'Coast', 'Valley'];
const BY_AREA: CustomColormap = {
  kind: 'categorical',
  colors: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948'],
  categories: AREAS,
};
/** Samples per second, seconds kept, seconds shown, and seconds between automatic dips. */
const RATE = 50;
const KEEP = 60;
const WINDOW = 20;
const EVERY = 20;

/** How far a dip has pulled voltages down, `since` seconds after it struck; 0 after six seconds. */
const dip = (since: number) =>
  since < 0 || since > 6
    ? 0
    : 0.06 * Math.exp(-since * 1.4) * Math.sin(Math.min(since, 0.5) * Math.PI);

/** `n` signals' areas, names, offsets, and noise levels. */
function signals(n: number) {
  const next = random(11);
  const area = Float64Array.from({ length: n }, (_, i) => i % AREAS.length);
  const name = Array.from(
    { length: n },
    (_, i) => `${AREAS[i % AREAS.length]} ${Math.floor(i / AREAS.length) + 1}`,
  );
  const offset = Float32Array.from({ length: n }, () => next() - 0.5);
  const noise = Float32Array.from({ length: n }, () => 0.3 + next());
  return { area, name, offset, noise, next };
}

export default page({
  title: 'Telemetry',
  settings: {
    source: choice('Source', { Live: 'live', 'Recorded day': 'day' }),
    count: choice('Signals', { '500': 500, '2,000': 2000, '10,000': 10_000 }, { value: 2000 }),
    color: choice('Color', { Area: 'area', Voltage: 'value' }, { key: 'c' }),
  },

  async open({ settings, view, actions, timeline, frame, detail }) {
    let s = signals(settings.count);
    const live = new Data('live').axis('time', 's').set('Signal', { name: s.name, area: s.area });
    const day = new Tiles('scada', 'history/frames.json');
    let t = 0;
    let struck = -Infinity;
    let area = 0;

    const plot = await view(
      (settings) => {
        const table = settings.source === 'live' ? live.table('Signal') : day.table('Signal');
        return {
          space: {
            plot: {
              x: { label: settings.source === 'live' ? 'Time (s)' : 'Time of day (s)' },
              y: { label: 'Voltage (pu)' },
            },
          },
          theme: { base: 'dark', background: '#101214', focus: { dim: 0.15 } },
          ease: 0,
          marks: [
            {
              lines: table,
              trace: 'value',
              width: when(selected())
                .then(2.5)
                .otherwise(settings.count > 2000 ? 0.6 : 1),
              color:
                settings.color === 'area'
                  ? field('area').colormap(BY_AREA)
                  : field('value').colormap('coolwarm').domain(0.94, 1.04),
              legend: settings.color === 'area' ? 'Area' : 'Voltage (pu)',
            },
          ],
        };
      },
      { camera: { x: [-WINDOW, 0] } },
    );
    timeline({ data: live, keep: KEEP });

    actions('Actions', [
      {
        label: 'Strike an area',
        key: 's',
        run: () => {
          area = (area + 1) % AREAS.length;
          struck = t;
        },
      },
      {
        label: 'Select the lowest',
        key: 'q',
        // A query reads the latest frame and returns the twelve lowest voltages, which the plot
        // then highlights.
        run: () => {
          const lowest = live.query({
            of: 'Signal',
            sort: [['$value', 'ascending']],
            limit: 12,
            at: t,
          });
          plot.selection = [{ data: 'live', table: 'Signal', ids: lowest.ids }];
        },
      },
    ]);

    // Every frame appends the samples that came due since the last, each signal swinging with its
    // area, with noise, and dipping when its area is struck.
    let carry = 0;
    let values = new Float32Array(settings.count);
    frame((dt) => {
      if (settings.source !== 'live') return;
      carry += dt;
      while (carry >= 1 / RATE) {
        carry -= 1 / RATE;
        t += 1 / RATE;
        const automatic = Math.floor(t / EVERY) % AREAS.length;
        for (let i = 0; i < values.length; i++) {
          const a = s.area[i]!;
          const dips = (a === automatic ? dip(t % EVERY) : 0) + (a === area ? dip(t - struck) : 0);
          const swing = Math.sin(t * (0.6 + a * 0.13) + a);
          values[i] =
            1 + 0.03 * s.offset[i]! + 0.012 * swing + 0.003 * (s.next() - 0.5) * s.noise[i]! - dips;
        }
        live.append('Signal', t, { value: values });
      }
      plot.camera = { x: [t - WINDOW, t] };
    });
    detail(`${settings.count.toLocaleString()} signals at ${RATE} Hz, ${KEEP} s kept`);

    return {
      change(next, key) {
        if (key === 'count') {
          s = signals(next.count);
          values = new Float32Array(next.count);
          live.replace('Signal', { name: s.name, area: s.area });
          detail(`${next.count.toLocaleString()} signals at ${RATE} Hz, ${KEEP} s kept`);
        }
        if (key === 'source')
          return () => {
            if (next.source === 'day') plot.camera = { x: [0, 86_400] };
            detail(
              next.source === 'day'
                ? '64 buses every 15 s for a day, fetched as time tiles'
                : `${next.count.toLocaleString()} signals at ${RATE} Hz`,
            );
          };
      },
    };
  },
});
