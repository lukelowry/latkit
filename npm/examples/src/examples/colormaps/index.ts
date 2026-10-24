/**
 * The colormap catalog on a field of hexagons: each cell an area colored on the GPU through the
 * chosen colormap, beside the same colormap as a CSS ramp, so the two can be compared. Choose a
 * colormap, a field to show and how many cells, how the value is transformed on its way to the map,
 * and which cells show; hover a cell to read it, or brush over the field to read what lies under it.
 */
import {
  Data,
  Patch,
  colormapCss,
  field,
  type Colormap,
  type ColormapName,
  type Expr,
  type Mark,
  type Scene,
} from '../../latkit.js';
import { h } from '../../ui/dom.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';

/**
 * Maps of our own: clear to a placed, half-clear blue, then an opaque amber, whose alpha shows the
 * plane's grid through the cells; a diverging one from teal through a light middle to rust; and a
 * cyclic one, whose ends meet.
 */
const CUSTOM = {
  custom: { kind: 'sequential', colors: ['#2a6fdb00', [0.55, '#2a6fdb99'], '#ffb000'] },
  diverging: { kind: 'diverging', colors: ['#00727a', '#e8e4d8', '#b5462a'] },
  cyclic: { kind: 'cyclic', colors: ['#3b5bdb', '#e64980', '#fab005', '#3b5bdb'] },
} as const satisfies Record<string, Colormap>;
/** A colormap of the catalog, or one of ours. */
type Choice = ColormapName | keyof typeof CUSTOM;
const mapOf = (choice: Choice): Colormap =>
  choice in CUSTOM ? CUSTOM[choice as keyof typeof CUSTOM] : (choice as ColormapName);

/** How a cell's value, 0 to 1, is carried to the colormap, each again 0 to 1. */
const TRANSFORMS: Record<string, [label: string, (v: Expr) => Expr]> = {
  none: ['As is', (v) => v],
  sqrt: ['Square root', (v) => v.sqrt()],
  squared: ['Squared', (v) => v.pow(2)],
  log: ['Logarithm', (v) => v.mul(9).add(1).ln().div(Math.LN10)],
  exp: [
    'Exponential',
    (v) =>
      v
        .exp()
        .sub(1)
        .div(Math.E - 1),
  ],
  bands: ['Eight bands', (v) => v.mul(8).floor().div(8)],
  stripes: ['Stripes', (v) => v.mul(10).rem(1)],
  waves: [
    'Waves',
    (v) =>
      v
        .mul(4 * Math.PI)
        .cos()
        .mul(0.5)
        .add(0.5),
  ],
  middle: ['From the middle', (v) => v.sub(0.5).abs().mul(2)],
  inverted: ['Inverted', (v) => v.neg().add(1)],
  clamped: ['Middle half', (v) => v.sub(0.25).mul(2).clamp(0, 1)],
  edges: ['Nearer edge', (v) => v.min(v.neg().add(1)).mul(2)],
  peaks: ['Peaks only', (v) => v.sub(0.6).max(0).div(0.4)],
};
type Transform = keyof typeof TRANSFORMS;
/** Which cells show: a band of values, or of classes. */
type Show = 'all' | 'inside' | 'outside' | 'not' | 'class' | 'others';
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
  ['Custom', ['custom', 'diverging', 'cyclic']],
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

/** A field of `columns` by `rows` hexagons of side 1, pointy side up, as a patch replacing table
 * `Cell`: each cell's polygon, its value, its class of ten, and its value written. */
function hexagons(columns: number, rows: number, value: FieldName): Patch {
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
  const label = Array.from(values, (v) => v.toFixed(2));
  return new Patch().replace('Cell', { count }, { geometry, value: values, class: classes, label });
}

export default function page(stage: Stage): void {
  let colormap: Choice = 'viridis';
  let value: FieldName = 'peaks';
  let size: [number, number] = [96, 64];
  let outline = false;
  let reversed = false;
  let light = false;
  let transform: Transform = 'none';
  let show: Show = 'all';
  let band: [number, number] = [0.3, 0.7];
  let classed = 5;
  let labels = false;
  let ownLegend = false;
  /** One dataset, replaced field by field: the view eases each cell from its color to the next. */
  const data = new Data('colors');
  stage.signal.addEventListener('abort', () => data.destroy());

  /** Whether a cell shows, as the panel says. */
  const visible = (): Expr | boolean => {
    const v = field('value');
    const c = field('class');
    switch (show) {
      case 'inside':
        return v.ge(band[0]).and(v.le(band[1]));
      case 'outside':
        return v.lt(band[0]).or(v.gt(band[1]));
      case 'not':
        return v.ge(band[0]).and(v.le(band[1])).not();
      case 'class':
        return c.eq(classed);
      case 'others':
        return c.ne(classed);
      default:
        return true;
    }
  };

  const scene = (): Scene => {
    const categorical = CATEGORICAL.has(colormap);
    const input = categorical ? field('class') : TRANSFORMS[transform]![1](field('value'));
    const mapped = input.colormap(mapOf(colormap));
    const outlines: Mark[] = outline
      ? [
          {
            lines: {
              of: ['colors', 'Cell'],
              color: light ? '#f7f8fa' : theme.background,
              width: 0.75,
            },
          },
        ]
      : [];
    return {
      // Lines under the cells show through what a map leaves clear.
      space: { plane: { grid: colormap === 'custom' ? { lines: { pitch: 4 } } : 'off' } },
      // The base themes by name.
      theme: light ? 'light' : 'dark',
      ease: 0.25,
      marks: [
        {
          // The cells are what the page reads: hovering one reads its value.
          areas: {
            of: ['colors', 'Cell'],
            color: categorical ? mapped : reversed ? mapped.domain(1, 0) : mapped.domain(0, 1),
            visible: visible(),
            pick: true,
            // Where values matter most, their cells are labeled first.
            priority: 'value',
            ...(labels ? { label: { text: 'label', size: 10, max: 60 } } : {}),
            ...(ownLegend ? { legend: TRANSFORMS[transform]![0] } : {}),
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
    data.apply(hexagons(columns, rows, value));
    view.setData(data);
    stage.detail(`${(columns * rows).toLocaleString()} cells`);
  };
  const restyle = () => {
    view.show(scene());
    legend.ramp(
      mapOf(colormap),
      `${colormap}${CATEGORICAL.has(colormap) ? ', ten classes' : reversed ? ', reversed' : ''}`,
    );
    legend.hidden = ownLegend;
    for (const [name, swatch] of swatches)
      swatch.setAttribute('aria-pressed', String(name === colormap));
  };

  const palette = stage.section('Colormap');
  const ours: Record<keyof typeof CUSTOM, string> = {
    custom: 'ours · alpha, a placed stop',
    diverging: 'ours · diverging',
    cyclic: 'ours · cyclic',
  };
  const choose = palette.choice(
    'Colormap',
    CATALOG.flatMap(([kind, names]) =>
      names.map(
        (name) =>
          [
            name in ours ? ours[name as keyof typeof CUSTOM] : `${name} · ${kind.toLowerCase()}`,
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
  palette.toggle('Legend in the view', undefined, ownLegend, (on) => {
    ownLegend = on;
    restyle();
  });
  palette.choice(
    'Transform',
    Object.entries(TRANSFORMS).map(([key, [label]]) => [label, key as Transform] as const),
    transform,
    (next) => {
      transform = next;
      restyle();
    },
  );

  const shown = stage.section('Field');
  shown.choice(
    'Value',
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
  shown.toggle('Labels', 'b', labels, (on) => {
    labels = on;
    restyle();
  });
  shown.choice(
    'Show',
    [
      ['Every cell', 'all'],
      ['Values in the band', 'inside'],
      ['Values outside it', 'outside'],
      ['All but the band', 'not'],
      ['One class', 'class'],
      ['All but one class', 'others'],
    ] as const,
    show,
    (next) => {
      show = next;
      restyle();
    },
  );
  const bound = (k: 0 | 1, label: string) =>
    shown.range(
      label,
      { min: 0, max: 1, step: 0.05, value: band[k], format: (v) => v.toFixed(2) },
      (v) => {
        band = k ? [band[0], v] : [v, band[1]];
        if (show !== 'all') restyle();
      },
    );
  bound(0, 'Band from');
  bound(1, 'Band to');
  shown.range('Class', { min: 0, max: 9, step: 1, value: classed, format: String }, (v) => {
    classed = v;
    if (show === 'class' || show === 'others') restyle();
  });
  const reading = shown.note('Hover a cell.');
  view.on('hover', ({ hit }) => {
    if (!hit) return void (reading.textContent = 'Hover a cell.');
    const v = data.get('Cell', hit.row.id, 'value') as number | null;
    reading.textContent = `Cell ${hit.row.id}: ${v?.toFixed(3) ?? '–'}`;
  });

  // A brush: the cells within its reach of the pointer, read by a pick, and their mean value.
  let reach = 24;
  shown.range(
    'Brush',
    { min: 4, max: 80, step: 4, value: reach, format: (v) => `${v} px` },
    (v) => (reach = v),
  );
  const brushed = shown.note('Brush over the field.');
  let brushing = false;
  stage.regions.main.querySelector('canvas')!.addEventListener(
    'pointermove',
    (event) => {
      if (brushing) return;
      brushing = true;
      void view
        .pick([event.offsetX, event.offsetY], reach)
        .then((hits) => {
          const values = hits.map((hit) => data.get('Cell', hit.row.id, 'value') as number);
          const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
          brushed.textContent = hits.length
            ? `${hits.length} cells under the brush, mean ${mean.toFixed(3)}`
            : 'Brush over the field.';
        })
        .catch(() => {})
        .finally(() => (brushing = false));
    },
    { signal: stage.signal },
  );

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
    catalog.content.append(title);
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
    catalog.content.append(grid);
  }

  stage.meter(view);
  rebuild();
  restyle();
  view.fit();
}
