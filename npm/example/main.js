// A synthetic power grid: buses on a jittered lattice over Texas, lines to their neighbors, and a
// voltage recorded every second for a minute, played back on a map, a globe, or a plane.
import { Data, Gpu, Patch, field, reference } from '../dist/index.js';

const status = document.getElementById('status');
const canvas = document.getElementById('canvas');

const side = 60;
const buses = side * side;
const random = mulberry32(7);
const lon = new Float64Array(buses);
const lat = new Float64Array(buses);
const kv = new Float64Array(buses);
for (let i = 0; i < buses; i++) {
  lon[i] = -106 + ((i % side) + random() * 0.6) * (12 / side);
  lat[i] = 26 + (Math.floor(i / side) + random() * 0.6) * (10 / side);
  kv[i] = [69, 138, 345][Math.floor(random() * 3)];
}
const from = [];
const to = [];
for (let i = 0; i < buses; i++) {
  if (i % side < side - 1) from.push(i), to.push(i + 1);
  if (i + side < buses) from.push(i), to.push(i + side);
}

const grid = new Data('grid');
grid.apply(
  new Patch()
    .axis('time', 's')
    .set('Bus', buses, { lon, lat, kv })
    .set('Line', from.length, { from: reference('Bus', from), to: reference('Bus', to) }),
);
for (let t = 0; t < 60; t++) {
  const vm = new Float32Array(buses);
  for (let i = 0; i < buses; i++) {
    const x = (i % side) / side;
    const y = Math.floor(i / side) / side;
    vm[i] = 1 + 0.04 * Math.sin(6 * x + t / 6) * Math.cos(5 * y - t / 9);
  }
  grid.apply(new Patch().append(t, 'Bus', { vm }));
}

const scene = (space) => ({
  space,
  marks: [
    { edges: { of: ['grid', 'Line'], ends: ['from', 'to'], width: 1 } },
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

try {
  const gpu = await Gpu.create();
  const view = gpu.view(canvas, scene('earth'));
  view.setData(grid);
  view.fit();
  window.latkit = { view, grid };
  for (const button of document.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      view.show(scene(button.dataset.space));
      view.fit();
    });
  }
  const start = performance.now();
  const play = () => {
    view.at = (((performance.now() - start) / 1000) * 4) % 60;
    status.textContent = `t = ${view.at.toFixed(1)} s · ${buses} buses · ${from.length} lines`;
    requestAnimationFrame(play);
  };
  play();
} catch (error) {
  status.textContent = String(error);
  throw error;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
