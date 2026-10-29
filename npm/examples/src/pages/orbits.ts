/**
 * A spiral galaxy whose bodies orbit its center. Each body's position is an expression of the
 * elapsed time, its radius, phase, and angular speed, evaluated on the GPU: once the data is
 * uploaded, no frame writes a byte, however many bodies move. Inner bodies orbit faster than outer
 * ones, so the arms wind as time passes. Near the pointer, bodies swell like a lens.
 */
import { Data, elapsed, field, pointer, type CustomColormap } from 'latkit';
import { page, choice, toggle } from '../shell/page.js';
import { random } from '../random.js';

/** Glowing colors, translucent where faint, so crowded bodies brighten one another. */
const GLOW: CustomColormap = {
  kind: 'sequential',
  colors: ['#2a1b5c66', '#7b2cbf99', '#e0559dbb', '#ff9e64dd', '#fff1c9'],
};

/** Places `n` bodies in a disk with four arms: their radius, phase, angular speed, and height. */
function galaxy(n: number) {
  const next = random(7);
  const gauss = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  const r = new Float64Array(n);
  const phase = new Float64Array(n);
  const speed = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = 0.3 + 12 * next() ** 1.6;
    // Arms trail along a logarithmic spiral, with bodies scattered about them.
    const arm = (i % 4) * (Math.PI / 2);
    phase[i] = arm + 1.9 * Math.log(r[i]!) + 0.35 * gauss();
    // A flat rotation curve: the same orbital speed at every radius, so angular speed falls as 1/r.
    speed[i] = 0.9 / (r[i]! + 0.6);
    z[i] = 0.25 * gauss() * Math.exp(-r[i]! / 5);
  }
  return { r, phase, speed, z };
}

export default page({
  title: 'Orbits',
  inspect: false,
  settings: {
    bodies: choice(
      'Bodies',
      { '50 thousand': 50_000, '200 thousand': 200_000, '1 million': 1_000_000 },
      { value: 200_000 },
    ),
    color: choice('Color', { 'Orbital speed': 'speed', Distance: 'r' }),
    lens: toggle('Lens', { value: true, key: 'l' }),
  },
  async open({ settings, view, detail }) {
    const data = new Data('galaxy').set('Body', galaxy(settings.bodies));
    const angle = field('phase').add(field('speed').mul(elapsed()));
    const shown = await view(
      (s) => ({
        space: { plane: { grid: 'off' } },
        theme: { base: 'dark', background: '#05060b' },
        controls: { hover: false },
        marks: [
          {
            vertices: data.table('Body'),
            position: [field('r').mul(angle.cos()), field('r').mul(angle.sin())],
            elevation: '$z',
            // Up to three times as large right at the pointer, normal 120 pixels away.
            radius: s.lens ? pointer().div(120).neg().add(1).max(0).mul(2).add(1).mul(1.3) : 1.3,
            color:
              s.color === 'speed'
                ? field('speed').colormap(GLOW).domain(0.07, 1.2)
                : field('r').neg().colormap(GLOW).domain(-12.3, -0.3),
            pick: false,
          },
        ],
      }),
      { camera: { center: [0, 0], zoom: 5, pitch: 52, bearing: 0 } },
    );
    // The disk fills the view, seen from the camera's angle.
    void shown.fit({ bounds: { min: [-12.5, -12.5, 0], max: [12.5, 12.5, 0] } });
    detail(`${settings.bodies.toLocaleString()} bodies, moved by the GPU`);
    return {
      change(s, key) {
        if (key !== 'bodies') return;
        data.replace('Body', galaxy(s.bodies));
        detail(`${s.bodies.toLocaleString()} bodies, moved by the GPU`);
      },
    };
  },
});
