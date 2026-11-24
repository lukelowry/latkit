/**
 * A one-line diagram of a generated grid, drawn flat with y down, as a page is drafted. Buses are
 * bars, and lines run from one bar to the next and stop where they meet it. Transformers and
 * breakers are markers along their line, and generators, loads, and capacitors are symbols.
 * Comets move the way power flows, faster where more flows. Every size is in position units, the
 * comets' too, so the drawing zooms as one.
 */
import { Data, field, reference, symbol, units, when, type StrokeMarker } from 'latkit';
import { choice, page, toggle } from '../shell/page.js';
import { random } from '../random.js';

/** Each voltage level, from the top row down, and its color. */
const LEVELS = [345, 138, 69];
const COLORS = ['#e5486f', '#e6c84f', '#2fa49b'];
/** How far apart buses and rows of buses lie, in position units. */
const [ACROSS, DOWN] = [150, 190];
/** How fast comets move for each megawatt, in position units a second. */
const PACE = 0.6;

/** A generator, a load, and a capacitor, as SVG path data in a box from -1 to 1. */
const DEVICES = [
  'M-1 0A1 1 0 1 0 1 0A1 1 0 1 0-1 0ZM-.55 0C-.4-.55-.15-.55 0 0S.4 .55 .55 0',
  'M-.7-.6H.7L0 .9Z',
  'M0-1V-.2M-.8-.2H.8M-.8 .2H.8M0 .2V1',
];
/** A transformer's two windings, one after the other along its line. */
const TRANSFORMER =
  'M0-.9A.5 .5 0 1 0 0 .1A.5 .5 0 1 0 0-.9ZM0-.1A.5 .5 0 1 0 0 .9A.5 .5 0 1 0 0-.1Z';

/** How many buses each row of a station holds, from the top row down. */
const ROWS = [4, 8, 12];

/** Writes into `data` a grid of `count` buses, as stations side by side and one under another. A
 * station is three rows of buses, each bus fed from the row above, with its devices. Returns how
 * many branches join them. */
function grid(data: Data, count: number): number {
  const next = random(11);
  const bus = { x: [] as number[], y: [] as number[], kv: [] as number[], width: [] as number[] };
  const branch = { from: [] as number[], to: [] as number[], bends: [] as number[][][] };
  // A branch's megawatts, whether its breakers are open, and how far along it its transformer
  // sits, or 0 for a line without one.
  const flows = { mw: [] as number[], open: [] as boolean[], windings: [] as number[] };
  const join = (a: number, b: number, bends: number[][], windings = 0) => {
    branch.from.push(a);
    branch.to.push(b);
    branch.bends.push(bends);
    // An open breaker carries nothing.
    const open = next() < 0.08;
    flows.mw.push(open ? 0 : Math.round((next() - 0.3) * 240));
    flows.open.push(open);
    flows.windings.push(windings);
  };
  const device = {
    x: [] as number[],
    y: [] as number[],
    kind: [] as number[],
  };
  const tap = { bus: [] as number[], device: [] as number[], mw: [] as number[] };
  // A device's megawatts, and the side of it they are written on.
  const power = { mw: [] as number[], side: [] as string[] };
  const attach = (b: number, kind: number, dx: number, up: boolean) => {
    const [x, y] = [bus.x[b]! + dx, bus.y[b]! + (up ? -70 : 70)];
    device.x.push(x);
    device.y.push(y);
    device.kind.push(kind);
    // A generator feeds its bus, a load draws from it, and a capacitor moves no real power.
    const mw = Math.round(20 + 180 * next());
    power.mw.push(kind === 2 ? NaN : mw);
    power.side.push(up ? 'right' : 'bottom');
    tap.mw.push(kind === 0 ? -mw : kind === 1 ? mw : 0);
    tap.bus.push(b);
    tap.device.push(device.x.length - 1);
  };
  const span = Math.max(...ROWS) * ACROSS;
  const per = ROWS.reduce((a, b) => a + b);
  const stations = Math.max(1, Math.round(count / per));
  // About as many stations across as down fill a wide view.
  const across = Math.ceil(Math.sqrt(stations * 0.6));
  for (let station = 0; station < stations; station++) {
    const [left, top] = [
      (station % across) * (span + 300),
      Math.floor(station / across) * (2 * DOWN + 380),
    ];
    const first = ROWS.map((_, r) => bus.x.length + ROWS.slice(0, r).reduce((a, b) => a + b, 0));
    ROWS.forEach((n, r) => {
      for (let i = 0; i < n; i++) {
        bus.x.push(left + ((i + 0.5) / n) * span);
        bus.y.push(top + r * DOWN);
        bus.kv.push(LEVELS[r]!);
        bus.width.push(70);
      }
    });
    // Each bus hangs from the bus above it, through a transformer halfway down the line's last
    // leg. The line leaves the bar above at a place of its own, and crosses over at a height of
    // its own.
    for (let r = 1; r < ROWS.length; r++) {
      const above = (i: number) => first[r - 1]! + Math.floor((i * ROWS[r - 1]!) / ROWS[r]!);
      for (let i = 0, nth = 0; i < ROWS[r]!; i++, nth++) {
        const [a, b] = [above(i), first[r]! + i];
        if (i > 0 && above(i - 1) !== a) nth = 0;
        const from = bus.x[a]! - 24 + 16 * nth;
        const mid = bus.y[a]! + DOWN * (0.26 + 0.08 * (nth % 3));
        // The path's legs, between its points: out of the bus above, across, and down.
        const legs = [
          Math.hypot(from - bus.x[a]!, mid - bus.y[a]!),
          Math.abs(bus.x[b]! - from),
          bus.y[b]! - mid,
        ];
        const windings = 1 - legs[2]! / 2 / (legs[0]! + legs[1]! + legs[2]!);
        join(
          a,
          b,
          [
            [from, mid],
            [bus.x[b]!, mid],
          ],
          windings,
        );
        bus.width[a] = Math.max(bus.width[a]!, 70 + 32 * nth);
      }
    }
    // Some neighbors in a row are tied bar to bar.
    ROWS.forEach((n, r) => {
      for (let i = 0; i + 1 < n; i++) if (next() < 0.45) join(first[r]! + i, first[r]! + i + 1, []);
    });
    // Generators stand over the top row, and loads and capacitors hang under the bottom one.
    for (let i = 0; i < ROWS[0]!; i++) attach(first[0]! + i, 0, 0, true);
    for (let i = 0; i < ROWS[2]!; i++) {
      attach(first[2]! + i, 1, -16, false);
      if (next() < 0.3) attach(first[2]! + i, 2, 20, false);
    }
  }
  const names = bus.kv.map((kv, i) => `${kv === 345 ? 'N' : kv === 138 ? 'M' : 'S'}${i + 1}`);
  data
    .replace('Bus', { ...bus, name: names })
    .replace('Branch', {
      from: reference('Bus', branch.from),
      to: reference('Bus', branch.to),
      bends: branch.bends,
      ...flows,
    })
    .replace('Device', { ...device, ...power })
    .replace('Tap', {
      bus: reference('Bus', tap.bus),
      device: reference('Device', tap.device),
      mw: tap.mw,
    });
  return branch.from.length;
}

/** The markers along each branch: its transformer, and a breaker near each end. */
function along(breakers: boolean): StrokeMarker[] {
  const breaker = when(field('open')).then('#e5486f').otherwise('#3ecf8e');
  const windings = symbol(TRANSFORMER, { stroke: units(1.5) });
  return [
    { marker: windings, at: '$windings', size: units(26), visible: field('windings').gt(0) },
    ...(breakers
      ? [
          {
            marker: 'rectangle' as const,
            at: 0,
            offset: units(14),
            size: units(9),
            color: breaker,
          },
          {
            marker: 'rectangle' as const,
            at: 1,
            offset: units(-14),
            size: units(9),
            color: breaker,
          },
        ]
      : []),
  ];
}

/** Each row's comets: toward its second end while its megawatts are positive. */
const flow = (on: boolean) => (on ? field('mw').mul(PACE) : 0);

export default page({
  title: 'One-line',
  settings: {
    buses: choice('Buses', { '24': 24, '120': 120, '600': 600 }),
    breakers: toggle('Breakers', { value: true, key: 'b' }),
    flows: toggle('Flows', { value: true, key: 'f' }),
  },
  async open({ settings, view, detail }) {
    const data = new Data('grid');
    const count = (buses: number) =>
      detail(`${buses.toLocaleString()} buses · ${grid(data, buses).toLocaleString()} branches`);
    count(settings.buses);
    const kv = field('kv').colormap({ kind: 'categorical', colors: COLORS, values: LEVELS });
    const shown = await view((s) => ({
      space: { plane: { grid: 'off', y: 'down' } },
      theme: {
        base: 'dark',
        edge: { halo: units(4), width: 1.5 },
        flow: { spacing: units(80), length: units(40), width: units(7) },
      },
      // A one-line is flat: nothing turns the view.
      controls: { gestures: { 'shift+primary': 'box', secondary: 'none' } },
      marks: [
        {
          edges: data.table('Branch'),
          ends: ['from', 'to'],
          bends: 'bends',
          meet: 'nearest',
          width: units(2, { atLeast: 1 }),
          // Each side of a transformer has the color of its own bus.
          blend: '$windings',
          flow: flow(s.flows),
          markers: along(s.breakers),
        },
        {
          edges: data.table('Tap'),
          ends: ['bus', 'device'],
          meet: 'nearest',
          width: units(2, { atLeast: 1 }),
          flow: flow(s.flows),
        },
        {
          vertices: data.table('Bus'),
          position: ['$x', '$y'],
          size: [units('$width'), units(7, { atLeast: 2 })],
          marker: 'rectangle',
          color: kv,
          legend: 'kV',
          // Over the bar's left end, clear of the lines that reach it.
          label: { text: '$name', place: 'top-left', offset: [units(26), 0], size: units(12) },
        },
        {
          vertices: data.table('Device'),
          position: ['$x', '$y'],
          radius: units(15),
          marker: symbol(DEVICES, { index: '$kind', stroke: units(1.8) }),
          color: '#c9d4e3',
          label: { text: '$mw', precision: 0, unit: ' MW', place: '$side', size: units(10) },
        },
      ],
    }));
    return {
      change(s, key) {
        if (key !== 'buses') return;
        count(s.buses);
        return () => void shown.fit('all');
      },
    };
  },
});
