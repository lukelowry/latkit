/** Torus silk: filaments twisting around a (2, 3) torus knot, drawn as edges in three dimensions. */
import { Data, field, reference } from 'latkit';
import type { Picture } from './render.ts';

type Vec = [number, number, number];

/** The knot's centerline at `t`. It goes around the torus twice while winding through the hole
 * three times. */
function knot(t: number): Vec {
  const r = 100 + 42 * Math.cos(3 * t);
  return [r * Math.cos(2 * t), r * Math.sin(2 * t), 42 * Math.sin(3 * t)];
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = ([a, b, c]: Vec): Vec => {
  const l = Math.hypot(a, b, c);
  return [a / l, b / l, c / l];
};
const cross = ([a, b, c]: Vec, [d, e, f]: Vec): Vec => [
  b * f - c * e,
  c * d - a * f,
  a * e - b * d,
];

export default function (): Picture {
  const filaments = 64;
  const samples = 900;
  const tube = 15;
  const n = filaments * samples;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const tone = new Float32Array(n);
  const h = 1e-3;
  for (let s = 0; s < samples; s++) {
    const t = (s / samples) * 2 * Math.PI;
    // The centerline's Frenet frame: tangent, normal (the direction it bends), and binormal.
    const tangent = unit(sub(knot(t + h), knot(t - h)));
    const ahead = unit(sub(knot(t + 2 * h), knot(t)));
    const behind = unit(sub(knot(t), knot(t - 2 * h)));
    const normal = unit(sub(ahead, behind));
    const binormal = cross(tangent, normal);
    const c = knot(t);
    for (let f = 0; f < filaments; f++) {
      // Each filament turns around the tube three times along the knot, so it closes on itself.
      const phase = (f / filaments) * 2 * Math.PI + 3 * t;
      const i = f * samples + s;
      x[i] = c[0] + tube * (Math.cos(phase) * normal[0] + Math.sin(phase) * binormal[0]);
      y[i] = c[1] + tube * (Math.cos(phase) * normal[1] + Math.sin(phase) * binormal[1]);
      z[i] = c[2] + tube * (Math.cos(phase) * normal[2] + Math.sin(phase) * binormal[2]) + 70;
      tone[i] = 0.5 + 0.5 * Math.sin(phase + t);
    }
  }
  // Point i's thread runs to the next point along its filament, and the last back to the first.
  const next = Uint32Array.from(
    { length: n },
    (_, i) => Math.floor(i / samples) * samples + (((i % samples) + 1) % samples),
  );
  const silk = new Data('silk').replace('Point', { x, y, z, tone }).replace('Thread', {
    from: reference('Point', { count: n }),
    to: reference('Point', next),
    tone,
  });
  return {
    scene: {
      space: { plane: { grid: 'off' } },
      ease: 0,
      theme: { background: '#0b0f14' },
      marks: [
        // The points draw nothing: they place the threads' ends in three dimensions.
        {
          vertices: silk.table('Point'),
          position: ['$x', '$y'],
          elevation: '$z',
          radius: 0,
          color: '#00000000',
          pick: false,
        },
        {
          edges: silk.table('Thread'),
          ends: ['from', 'to'],
          width: 0.7,
          pick: false,
          color: field('tone')
            .colormap({
              kind: 'sequential',
              colors: ['#2bb6e8', '#79e3d6', '#ffd39a', '#ff8f5e', '#ff5c7a'],
            })
            .domain(0, 1),
        },
      ],
    },
    camera: { center: [0, 14, 60], zoom: 0.62, pitch: 52, bearing: -18 },
  };
}
