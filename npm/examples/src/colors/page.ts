/**
 * The colormap catalog on a field of hexagons: each cell an area colored on the GPU through the
 * chosen colormap, beside the same colormap as a CSS ramp, so the two can be compared. Choose a
 * colormap, a field to show, and how many cells; hover a cell to read it.
 */
import {
  Data,
  Patch,
  colormapCss,
  field,
  type ColormapName,
  type Hit,
  type Mark,
  type Scene,
} from 'latkit';
import type { Stage } from '../ui/stage.js';
import { h } from '../ui/dom.js';

/** Every catalog colormap, by kind. */
const CATALOG: readonly (readonly [string, readonly ColormapName[]])[] = [
  [
    'Sequential',
    [
      'viridis',
      'cividis',
      'plasma',
      'inferno',
      'magma',
      'mako',
      'rocket',
      'crest',
      'flare',
      'amber',
      'amp',
      'batlow',
      'deep',
      'devon',
      'grays',
      'haline',
      'lajolla',
      'oslo',
      'thermal',
      'turku',
      'turbo',
    ],
  ],
  [
    'Diverging',
    [
      'balance',
      'berlin',
      'brbg',
      'broc',
      'coolwarm',
      'cork',
      'icefire',
      'managua',
      'piyg',
      'puor',
      'rdbu',
      'spectral',
      'vanimo',
      'vik',
      'vlag',
    ],
  ],
  ['Cyclic', ['phase', 'romao', 'twilight']],
  ['Categorical', ['tab10', 'tab20', 'tableau10', 'set2', 'dark2', 'paired', 'okabeito']],
];
const CATEGORICAL = new Set<ColormapName>(CATALOG[3]![1]);

/** What the cells show, each a value from 0 to 1 at a point; categorical maps read classes. */
const FIELDS = {
  waves: (x: number, y: number) =>
    0.5 + 0.3 * Math.sin(x * 0.11) * Math.cos(y * 0.09) + 0.2 * Math.sin((x + y) * 0.035),
  peaks: (x: number, y: number) => {
    const peak = (cx: number, cy: number, r: number) =>
      Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
    return Math.min(1, 0.9 * peak(30, 25, 14) + 0.7 * peak(80, 55, 20) + 0.5 * peak(110, 15, 10));
  },
  ramp: (x: number, _y: number, width: number) => x / width,
  angle: (x: number, y: number, width: number, height: number) =>
    (Math.atan2(y - height / 2, x - width / 2) / (2 * Math.PI) + 1) % 1,
} as const;
type FieldName = keyof typeof FIELDS;

/** A field of `columns` by `rows` hexagons of side 1, pointy side up, as dataset `colors`. */
function hexagons(columns: number, rows: number, value: FieldName): Data {
  const count = columns * rows;
  const width = columns * Math.sqrt(3);
  const height = rows * 1.5;
  const geometry: [number, number][][][] = [];
  const values = new Float64Array(count);
  const classes = new Float64Array(count);
  const s = Math.sqrt(3);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const x = c * s + (r % 2) * (s / 2);
      const y = r * 1.5;
      const ring: [number, number][] = [];
      for (let k = 0; k <= 6; k++) {
        const a = (Math.PI / 3) * (k % 6) + Math.PI / 6;
        ring.push([x + Math.cos(a), y + Math.sin(a)]);
      }
      geometry.push([ring]);
      const v = FIELDS[value](x, y, width, height);
      values[r * columns + c] = v;
      classes[r * columns + c] = Math.min(9, Math.floor(v * 10));
    }
  return new Data('colors').apply(
    new Patch().set('Cell', count, { geometry, value: values, class: classes }),
  );
}

export default function page(stage: Stage): void {
  let colormap: ColormapName = 'viridis';
  let value: FieldName = 'peaks';
  let size: [number, number] = [96, 64];
  let outline = false;
  let reversed = false;

  const scene = (): Scene => {
    const input = CATEGORICAL.has(colormap) ? field('class') : field('value');
    const mapped = input.colormap(colormap);
    const outlines: Mark[] = outline
      ? [{ lines: { of: ['colors', 'Cell'], color: '#090c11', width: 0.75, pick: false } }]
      : [];
    return {
      space: { plane: { grid: 'off' } },
      theme: { base: 'dark', background: '#090c11', hover: '#ffffffaa' },
      ease: 0.25,
      marks: [
        {
          areas: {
            of: ['colors', 'Cell'],
            color: CATEGORICAL.has(colormap)
              ? mapped
              : reversed
                ? mapped.domain(1, 0)
                : mapped.domain(0, 1),
          },
        },
        ...outlines,
      ],
    };
  };
  const view = stage.view(scene(), {
    label: 'A field of hexagons through a colormap: hover a cell to read it',
  });
  const legend = stage.legend();

  const rebuild = () => {
    const [columns, rows] = size;
    view.setData(hexagons(columns, rows, value));
    stage.detail(`${(columns * rows).toLocaleString()} cells, each an area of six triangles`);
  };
  const restyle = () => {
    view.show(scene());
    legend.ramp(
      colormap,
      `${colormap}${CATEGORICAL.has(colormap) ? ', ten classes' : reversed ? ', reversed' : ''}`,
    );
    for (const [name, swatch] of swatches)
      swatch.setAttribute('aria-pressed', String(name === colormap));
  };

  const palette = stage.section('Colormap');
  const choose = palette.choice(
    'Colormap',
    CATALOG.flatMap(([kind, names]) =>
      names.map((name) => [`${name} · ${kind.toLowerCase()}`, name] as const),
    ),
    colormap,
    (name) => {
      colormap = name;
      restyle();
    },
  );
  palette.toggle('Reversed', 'r', reversed, (on) => {
    reversed = on;
    restyle();
  });
  palette.toggle('Outlines', 'o', outline, (on) => {
    outline = on;
    restyle();
  });

  const shown = stage.section('Field');
  shown.choice(
    'Shows',
    [
      ['Peaks', 'peaks'],
      ['Waves', 'waves'],
      ['A ramp across', 'ramp'],
      ['The angle around', 'angle'],
    ] as const,
    value,
    (next) => {
      value = next;
      rebuild();
    },
  );
  shown.choice(
    'Cells',
    [
      ['1,500', [48, 32]],
      ['6,000', [96, 64]],
      ['24,000', [192, 128]],
      ['96,000', [384, 256]],
    ] as const,
    size as readonly [number, number],
    (next) => {
      size = [next[0], next[1]];
      rebuild();
      view.fit();
    },
  );
  const reading = shown.note('Hover a cell.');
  view.on('hover', (hit: Hit | null) => {
    if (!hit) return void (reading.textContent = 'Hover a cell.');
    const data = view.data('colors');
    const v = data?.get('Cell', hit.row.id, 'value') as number | null;
    reading.textContent = `Cell ${hit.row.id}: ${v?.toFixed(3) ?? '–'}`;
  });

  // The catalog as CSS ramps: the same texels the GPU samples, drawn by the browser.
  const catalog = stage.section('Catalog');
  const swatches = new Map<ColormapName, HTMLButtonElement>();
  for (const [kind, names] of CATALOG) {
    catalog.element.append(h('p', { class: 'note' }, kind));
    const grid = h('div', { class: 'swatches' });
    for (const name of names) {
      const swatch = h(
        'button',
        { type: 'button', class: 'swatch', title: name, 'aria-pressed': 'false' },
        h('span', { class: 'ramp' }),
        name,
      );
      (swatch.firstChild as HTMLElement).style.background = colormapCss(name);
      swatch.addEventListener(
        'click',
        () => {
          colormap = name;
          choose.selectedIndex = CATALOG.flatMap(([, n]) => n).indexOf(name);
          restyle();
        },
        { signal: stage.signal },
      );
      swatches.set(name, swatch);
      grid.append(swatch);
    }
    catalog.element.append(grid);
  }

  stage.meter(view);
  rebuild();
  restyle();
  view.fit();
}
