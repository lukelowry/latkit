import { Data, Patch, field, reference, type Scene } from 'latkit';
import type { Stage } from '../ui/stage.js';

/** Buses on a side of the lattice. */
const SIDE = 60;
/** Seconds of recorded voltages. */
const SECONDS = 60;

/** A synthetic grid over Texas: buses on a jittered lattice, lines to their neighbors, and a minute of
 * voltages that ripple across it. */
function grid(): { data: Data; buses: number; lines: number } {
  const buses = SIDE * SIDE;
  const random = mulberry32(7);
  const lon = new Float64Array(buses);
  const lat = new Float64Array(buses);
  const kv = new Float64Array(buses);
  for (let i = 0; i < buses; i++) {
    lon[i] = -106 + ((i % SIDE) + random() * 0.6) * (12 / SIDE);
    lat[i] = 26 + (Math.floor(i / SIDE) + random() * 0.6) * (10 / SIDE);
    kv[i] = [69, 138, 345][Math.floor(random() * 3)]!;
  }
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < buses; i++) {
    if (i % SIDE < SIDE - 1) (from.push(i), to.push(i + 1));
    if (i + SIDE < buses) (from.push(i), to.push(i + SIDE));
  }
  const data = new Data('grid').apply(
    new Patch()
      .axis('time', 's')
      .set('Bus', buses, { lon, lat, kv })
      .set('Line', from.length, { from: reference('Bus', from), to: reference('Bus', to) }),
  );
  const vm = new Float32Array(buses);
  for (let t = 0; t <= SECONDS; t++) {
    for (let i = 0; i < buses; i++) {
      const x = (i % SIDE) / SIDE;
      const y = Math.floor(i / SIDE) / SIDE;
      vm[i] = 1 + 0.04 * Math.sin(6 * x + t / 6) * Math.cos(5 * y - t / 9);
    }
    data.apply(new Patch().append(t, 'Bus', { vm }));
  }
  return { data, buses, lines: from.length };
}

export default function page(stage: Stage): void {
  const { data, buses, lines } = grid();
  const scene = (space: Scene['space']): Scene => ({
    space,
    theme: { base: 'dark', background: '#090c11' },
    marks: [
      { edges: { of: ['grid', 'Line'], ends: ['from', 'to'], width: 1, pick: false } },
      {
        vertices: {
          of: ['grid', 'Bus'],
          position: ['lon', 'lat'],
          radius: field('kv').div(100).add(1),
          color: field('vm').colormap('balance').domain(0.96, 1.04),
        },
      },
    ],
  });
  const view = stage.view(scene('earth'), {
    label: 'A synthetic grid over Texas: click a bus to select it',
  });
  view.setData(data);
  view.fit();
  stage.section('Space').choice(
    'Draw on',
    [
      ['Map', 'earth'],
      ['Globe', 'globe'],
      ['Plane', 'plane'],
    ] as const,
    'earth',
    (space) => {
      view.show(scene(space));
      view.fit();
    },
  );
  const selected = stage.section('Selection');
  const readout = document.createElement('p');
  readout.className = 'series';
  readout.textContent = 'Click a bus.';
  selected.element.append(readout);
  const describe = () => {
    const [row] = view.selection;
    if (!row) return (readout.textContent = 'Click a bus.');
    const vm = data.get('Bus', row.id, 'vm', view.at) as number | null;
    readout.textContent = `Bus ${row.id}: ${data.get('Bus', row.id, 'kv')} kV, ${vm?.toFixed(3) ?? '–'} pu`;
  };
  view.on('select', describe);
  stage.legend().ramp('balance', 'Voltage 0.96 – 1.04 pu');
  stage.meter(view);
  const playback = stage.playback({
    live: false,
    rate: 4,
    show(at) {
      view.at = at;
      describe();
    },
  });
  playback.record(data.span!);
  stage.detail(
    `${buses.toLocaleString()} buses · ${lines.toLocaleString()} lines · ${SECONDS} s of voltages`,
  );
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
