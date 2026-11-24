/** Explore the drafted Hawaii40 case. Paths and labels share the CLI example's drawing coordinates. */
import { Data, field, units, type Mark } from 'latkit';
import drawing from '../../../../docs/gallery/hawaii/data.json?url';
import { page, toggle } from '../shell/page.js';

export default page({
  title: 'Hawaiʻi one-line',
  settings: {
    devices: toggle('Device symbols', { value: true }),
    labels: toggle('Bus numbers', { value: true }),
  },
  async open({ view, detail, credit, signal }) {
    const data = await Data.read(drawing);
    if (signal.aborted) {
      data.destroy();
      return;
    }
    signal.addEventListener('abort', () => data.destroy(), { once: true });
    const low = '#36424d';
    const high = '#9b6a16';
    const conductor = field('voltageClass').colormap({
      kind: 'categorical',
      values: [0, 1],
      colors: [low, high],
      categories: ['69 kV', '138 kV'],
    });
    const stroke = (name: string, color: string, width: number): Mark => ({
      lines: data.table(name),
      color,
      width: units(width, { atLeast: 0.85 }),
      pick: true,
    });
    await view((s) => ({
      space: { plane: { grid: 'off' } },
      theme: {
        base: 'light',
        background: '#ffffff',
        text: { color: '#171c20', font: 'sans-serif', halo: 0 },
      },
      marks: [
        {
          lines: data.table('Line'),
          color: conductor,
          width: units(2, { atLeast: 0.85 }),
          legend: 'Nominal voltage',
          pick: true,
        },
        stroke('Winding69', low, 2),
        stroke('Winding138', high, 2),
        stroke('Bus69', low, 5),
        stroke('Bus138', high, 6),
        ...(s.devices
          ? ['Generator', 'Load', 'Capacitor', 'OpenGenerator'].map((name) =>
              stroke(name, name === 'OpenGenerator' ? '#586169' : '#22292e', 2),
            )
          : []),
        {
          vertices: data.table('BusNumber'),
          position: ['$x', '$y'],
          marker: 'none',
          label: { text: '$text', size: { units: 16 } },
          visible: s.labels,
        },
      ],
    }));
    detail('Hawaii40 (37 buses, 89 branches)');
    credit('Synthetic Oʻahu case');
  },
});
