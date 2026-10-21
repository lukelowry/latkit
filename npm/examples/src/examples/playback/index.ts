import { random } from '../../random.js';
import { theme } from '../../ui/theme.js';
import {
  Data,
  Patch,
  color,
  field,
  missing,
  reference,
  when,
  type ColormapName,
  type Id,
  type Mark,
  type Scene,
} from '../../latkit.js';
import type { Stage } from '../../ui/stage.js';

/** Buses on a side of the lattice. */
const SIDE = 60;
/** Seconds of recorded voltages. */
const SECONDS = 60;

/** A synthetic grid over Texas: buses on a jittered lattice, lines to their neighbors, and a minute of
 * voltages that ripple across it. */
function grid(): { data: Data; buses: number; lines: number } {
  const buses = SIDE * SIDE;
  const rng = random(7);
  const lon = new Float64Array(buses);
  const lat = new Float64Array(buses);
  const kv = new Float64Array(buses);
  const name: string[] = [];
  for (let i = 0; i < buses; i++) {
    lon[i] = -106 + ((i % SIDE) + rng() * 0.6) * (12 / SIDE);
    lat[i] = 26 + (Math.floor(i / SIDE) + rng() * 0.6) * (10 / SIDE);
    kv[i] = [69, 138, 345][Math.floor(rng() * 3)]!;
    name.push(`Bus ${i + 1}`);
  }
  const from: number[] = [];
  const to: number[] = [];
  const link = (a: number, b: number) => {
    from.push(a);
    to.push(b);
  };
  for (let i = 0; i < buses; i++) {
    if (i % SIDE < SIDE - 1) link(i, i + 1);
    if (i + SIDE < buses) link(i, i + SIDE);
  }
  const data = new Data('grid').apply(
    new Patch()
      .axis('time', 's')
      .set('Bus', { count: buses }, { lon, lat, kv, name })
      .set(
        'Line',
        { count: from.length },
        { from: reference('Bus', from), to: reference('Bus', to) },
      ),
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
  const look = {
    space: 'mercator' as Scene['space'],
    colormap: 'balance' as ColormapName,
    /** How far from 1 pu the colormap's ends lie. */
    spread: 0.04,
    size: 1,
    lines: true,
    labels: true,
    outliers: false,
  };
  const scene = (): Scene => {
    const marks: Mark[] = [];
    if (look.lines)
      marks.push({ edges: { of: ['grid', 'Line'], ends: ['from', 'to'], width: 1, pick: false } });
    marks.push({
      vertices: {
        of: ['grid', 'Bus'],
        position: ['lon', 'lat'],
        radius: field('kv').div(100).add(1).mul(look.size),
        color: field('vm')
          .colormap(look.colormap)
          .domain(1 - look.spread, 1 + look.spread),
        // Buses past the colormap's ends ring, so they stand out at any zoom.
        ...(look.outliers
          ? {
              ring: when(field('vm').sub(1).abs().gt(look.spread))
                .then(color('#ffd166'))
                .otherwise(missing()),
            }
          : {}),
        ...(look.labels ? { label: { text: 'name', priority: 'kv', size: 10 } } : {}),
      },
    });
    return {
      space: look.space,
      theme,
      controls: { selectBox: true },
      marks,
    };
  };
  const view = stage.view(scene(), {
    label: 'A synthetic grid over Texas: click a bus to select it, or Shift-drag a box',
  });
  view.setData(data);
  view.fit();
  const legend = stage.legend();
  const restyle = () => {
    view.show(scene());
    legend.ramp(
      look.colormap,
      `Voltage ${(1 - look.spread).toFixed(2)} – ${(1 + look.spread).toFixed(2)} pu`,
    );
  };

  const space = stage.section('View');
  space.choice(
    'Projection',
    [
      ['Map', 'mercator'],
      ['Globe', 'globe'],
      ['Plane', 'plane'],
    ] as const,
    'mercator',
    (next) => {
      look.space = next;
      restyle();
      view.fit();
    },
  );
  space.actions([{ label: 'Fit', key: 'f', run: () => view.fit() }]);

  const style = stage.section('Display');
  style.choice(
    'Colormap',
    (['balance', 'vik', 'coolwarm', 'rdbu', 'berlin'] as const).map(
      (name) => [name, name] as const,
    ),
    look.colormap,
    (colormap) => {
      look.colormap = colormap;
      restyle();
    },
  );
  style.choice(
    'Range',
    [
      ['±2%', 0.02],
      ['±4%', 0.04],
      ['±6%', 0.06],
    ] as const,
    look.spread,
    (spread) => {
      look.spread = spread;
      restyle();
    },
  );
  style.range(
    'Bus size',
    { min: 0.5, max: 3, step: 0.25, value: look.size, format: (v) => `${v.toFixed(2)}×` },
    (size) => {
      if (size === look.size) return;
      look.size = size;
      restyle();
    },
  );
  style.toggle('Lines', 'l', look.lines, (on) => {
    look.lines = on;
    restyle();
  });
  style.toggle('Labels', 'n', look.labels, (on) => {
    look.labels = on;
    restyle();
  });
  style.toggle('Outliers', 'o', look.outliers, (on) => {
    look.outliers = on;
    restyle();
  });

  const selected = stage.section('Selection');
  const readout = selected.note();
  const describe = () => {
    const ids = view.selection.filter((rows) => rows.table === 'Bus').flatMap((rows) => rows.ids);
    const vm = (id: Id) => data.get('Bus', id, 'vm', view.at) as number | null;
    if (!ids.length) readout.textContent = 'Click a bus, or Shift-drag a box.';
    else if (ids.length === 1) {
      const id = ids[0]!;
      const kv = data.get('Bus', id, 'kv') as number | null;
      readout.textContent = `Bus ${id}: ${kv ?? '–'} kV, ${vm(id)?.toFixed(3) ?? '–'} pu`;
    } else {
      const values = ids.map(vm).filter((v): v is number => v !== null);
      readout.textContent = `${ids.length} buses: ${Math.min(...values).toFixed(3)} – ${Math.max(...values).toFixed(3)} pu`;
    }
  };
  view.on('select', describe);
  stage.meter(view);
  const playback = stage.playback({
    live: false,
    rate: 4,
    show(at) {
      view.at = at;
      describe();
    },
  });
  selected.speed([1, 4, 10], 4, (rate) => (playback.rate = rate));
  playback.record(data.span!);
  restyle();
  describe();
  stage.detail(
    `${buses.toLocaleString()} buses · ${lines.toLocaleString()} lines · ${SECONDS} s of voltages`,
  );
}
