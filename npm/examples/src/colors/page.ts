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
  type Colormap,
  type ColormapName,
  type Mark,
  type Scene,
} from '../latkit.js';
import type { Stage } from '../ui/stage.js';
import { h } from '../ui/dom.js';

/**
 * A map of our own: clear to a placed, half-clear blue, then an opaque amber. Over the plane's
 * grid, its alpha shows as the lines through the cells.
 */
const CUSTOM: Colormap = {
  kind: 'sequential',
  colors: ['#2a6fdb00', [0.55, '#2a6fdb99'], '#ffb000'],
};
/** A colormap of the catalog, or ours. */
type Choice = ColormapName | 'custom';
const mapOf = (choice: Choice): Colormap => (choice === 'custom' ? CUSTOM : choice);
/** A checkerboard under a ramp, so what is clear in it shows. */
const CHECKS = 'repeating-conic-gradient(#888 0 25%, #ccc 0 50%) 0 0 / 8px 8px';

/** Every catalog colormap by kind, then ours. */
const CATALOG: readonly (readonly [string, readonly Choice[]])[] = [
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
  ['Custom', ['custom']],
];
const CATEGORICAL = new Set<Choice>(CATALOG.find(([kind]) => kind === 'Categorical')![1]);
const KINDS = ['All', ...CATALOG.map(([kind]) => kind)] as const;

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
    new Patch().set('Cell', { count }, { geometry, value: values, class: classes }),
  );
}

export default function page(stage: Stage): void {
  let colormap: Choice = 'viridis';
  let value: FieldName = 'peaks';
  let size: [number, number] = [96, 64];
  let outline = false;
  let reversed = false;
  let light = false;

  const scene = (): Scene => {
    const input = CATEGORICAL.has(colormap) ? field('class') : field('value');
    const mapped = input.colormap(mapOf(colormap));
    const background = light ? '#f4f1ea' : '#090c11';
    const outlines: Mark[] = outline
      ? [{ lines: { of: ['colors', 'Cell'], color: background, width: 0.75, pick: false } }]
      : [];
    return {
      // Lines under the cells show through what a map leaves clear.
      space: { plane: { grid: colormap === 'custom' ? { lines: { pitch: 4 } } : 'off' } },
      theme: {
        base: light ? 'light' : 'dark',
        background,
        hover: light ? '#000000aa' : '#ffffffaa',
      },
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
    // The view keeps its own version of the data.
    const data = hexagons(columns, rows, value);
    view.setData(data);
    data.destroy();
    stage.detail(`${(columns * rows).toLocaleString()} cells, each an area of six triangles`);
  };
  const restyle = () => {
    view.show(scene());
    legend.ramp(
      mapOf(colormap),
      `${colormap}${CATEGORICAL.has(colormap) ? ', ten classes' : reversed ? ', reversed' : ''}`,
    );
    for (const [name, swatch] of swatches)
      swatch.setAttribute('aria-pressed', String(name === colormap));
  };

  const palette = stage.section('Colormap');
  const choose = palette.choice(
    'Colormap',
    CATALOG.flatMap(([kind, names]) =>
      names.map(
        (name) =>
          [
            name === 'custom' ? 'ours · alpha, a placed stop' : `${name} · ${kind.toLowerCase()}`,
            name,
          ] as const,
      ),
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
  palette.toggle('Light', 'l', light, (on) => {
    light = on;
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
  // By columns: a field three rows for every two columns wide.
  shown.choice(
    'Cells',
    [
      ['1,500', 48],
      ['6,000', 96],
      ['24,000', 192],
      ['96,000', 384],
    ] as const,
    size[0],
    (columns) => {
      size = [columns, (columns * 2) / 3];
      rebuild();
      view.fit();
    },
  );
  const reading = shown.note('Hover a cell.');
  view.on('hover', ({ hit }) => {
    if (!hit) return void (reading.textContent = 'Hover a cell.');
    const data = view.data('colors');
    const v = data?.get('Cell', hit.row.id, 'value') as number | null;
    reading.textContent = `Cell ${hit.row.id}: ${v?.toFixed(3) ?? '–'}`;
  });

  // The catalog as CSS ramps: the colors the GPU draws, drawn by the browser over checks, so
  // what a map leaves clear shows.
  const catalog = stage.section('Catalog');
  const groups: [string, HTMLElement[]][] = [];
  catalog.choice(
    'Kind',
    KINDS.map((kind) => [kind, kind] as const),
    'All',
    (shown) => {
      for (const [kind, elements] of groups)
        for (const element of elements) element.hidden = shown !== 'All' && shown !== kind;
    },
  );
  const swatches = new Map<Choice, HTMLButtonElement>();
  for (const [kind, names] of CATALOG) {
    const title = h('p', { class: 'note' }, kind);
    const grid = h('div', { class: 'swatches' });
    groups.push([kind, [title, grid]]);
    catalog.element.append(title);
    for (const name of names) {
      const swatch = h(
        'button',
        { type: 'button', class: 'swatch', title: name, 'aria-pressed': 'false' },
        h('span', { class: 'ramp' }),
        name,
      );
      (swatch.firstChild as HTMLElement).style.background =
        `${colormapCss(mapOf(name))}, ${CHECKS}`;
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
