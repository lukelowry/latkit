/**
 * The colormap catalog on a field of hexagons. Each cell is an area colored on the GPU through the
 * chosen colormap, shown beside the same colormap as a CSS ramp for comparison. Choose a colormap,
 * the field and number of cells, a transform applied to values before the colormap, and which cells
 * show. Hover a cell to read its value, or brush over the field to read the cells under the brush.
 */
import {
  Data,
  Patch,
  colormapCss,
  colormaps,
  field,
  when,
  zoom,
  type Colormap,
  type ColormapName,
  type Expr,
  type Mark,
  type Scene,
} from 'latkit';
import { h } from '../../ui/dom.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';

/**
 * Custom colormaps. `custom` runs from transparent to a semi-transparent blue at a placed stop,
 * then to opaque amber, so the plane's grid shows through the cells. `diverging` runs from teal
 * through a light middle to rust. `cyclic` ends where it starts.
 */
const CUSTOM = {
  custom: { kind: 'sequential', colors: ['#2a6fdb00', [0.55, '#2a6fdb99'], '#ffb000'] },
  diverging: { kind: 'diverging', colors: ['#00727a', '#e8e4d8', '#b5462a'] },
  cyclic: { kind: 'cyclic', colors: ['#3b5bdb', '#e64980', '#fab005', '#3b5bdb'] },
} as const satisfies Record<string, Colormap>;
/** A catalog colormap's name, or a key of `CUSTOM`. */
type Choice = ColormapName | keyof typeof CUSTOM;
const mapOf = (choice: Choice): Colormap =>
  choice in CUSTOM ? CUSTOM[choice as keyof typeof CUSTOM] : (choice as ColormapName);

/** Transforms from a cell's value, 0 to 1, to the colormap's input, also 0 to 1, with labels. */
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
/** Which cells show: all of them, or those selected by a band of values or by class. */
type Show = 'all' | 'inside' | 'outside' | 'not' | 'class' | 'others';
/** A checkerboard behind each ramp, so a colormap's transparent parts are visible. */
const CHECKS = 'repeating-conic-gradient(#888 0 25%, #ccc 0 50%) 0 0 / 8px 8px';

/** The catalog's colormaps grouped by kind, each kind titled, then the custom ones. */
function catalog(): (readonly [kind: string, names: readonly Choice[]])[] {
  const all = colormaps();
  const kinds = [...new Set(all.map((map) => map.kind))];
  const title = (kind: string) => `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
  return [
    ...kinds.map(
      (kind) =>
        [title(kind), all.filter((map) => map.kind === kind).map((map) => map.name)] as const,
    ),
    ['Custom', ['custom', 'diverging', 'cyclic']],
  ];
}

/** Fields the cells can show, each a value from 0 to 1 at a point. Categorical colormaps show the
 * value's class instead. */
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

/** A patch that replaces table `Cell` with `columns` by `rows` pointy-top hexagons of side 1. Each
 * cell has its polygon, its value, its class from 0 to 9, and its value as label text. */
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
  const byKind = catalog();
  const categoricalMaps = new Set<Choice>(byKind.find(([kind]) => kind === 'Categorical')?.[1]);
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
  /** One dataset, replaced whenever the field or cell count changes. The view eases each cell from
   * its old color to its new one. */
  const data = new Data('colors');
  stage.signal.addEventListener('abort', () => data.destroy());

  /** Whether each cell shows, from the Show setting. */
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
    const categorical = categoricalMaps.has(colormap);
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
      // Grid lines under the cells show through a colormap's transparent parts.
      space: { plane: { grid: colormap === 'custom' ? { lines: { pitch: 4 } } : 'off' } },
      // A built-in theme, by name.
      theme: light ? 'light' : 'dark',
      ease: 0.25,
      marks: [
        {
          // The cells are pickable, so hovering one reads its value.
          areas: {
            of: ['colors', 'Cell'],
            color: categorical ? mapped : reversed ? mapped.domain(1, 0) : mapped.domain(0, 1),
            visible: visible(),
            pick: true,
            // A cell is labeled once it is wide enough for its value, from zoom 4 (16 pixels per
            // unit). Below that its text is missing, and it has no label.
            ...(labels
              ? {
                  label: {
                    text: when(zoom().ge(4)).then(field('label')).otherwise(null),
                    size: 10,
                  },
                }
              : {}),
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
  view.sources = [data];
  const legend = stage.legend();

  const rebuild = () => {
    const [columns, rows] = size;
    data.apply(hexagons(columns, rows, value));
    stage.detail(`${(columns * rows).toLocaleString()} cells`);
  };
  const restyle = () => {
    view.scene = scene();
    legend.ramp(
      mapOf(colormap),
      `${colormap}${categoricalMaps.has(colormap) ? ', ten classes' : reversed ? ', reversed' : ''}`,
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
    byKind.flatMap(([kind, names]) =>
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
  // Sized by column count, with two rows for every three columns.
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
  view.on('hovered', ({ hit }) => {
    if (!hit) return void (reading.textContent = 'Hover a cell.');
    const v = data.get('Cell', hit.row.id, 'value') as number | null;
    reading.textContent = `Cell ${hit.row.id}: ${v?.toFixed(3) ?? '–'}`;
  });

  // A brush: a pick finds the cells within `reach` CSS pixels of the pointer, and the note shows
  // their mean value.
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
        .pick([event.offsetX, event.offsetY], { radius: reach })
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

  // The catalog as CSS ramps: the same colors the GPU draws, drawn by the browser over a
  // checkerboard so transparent parts show.
  const ramps = stage.section('Catalog');
  const groups: [string, HTMLElement[]][] = [];
  ramps.choice(
    'Kind',
    ['All', ...byKind.map(([kind]) => kind)].map((kind) => [kind, kind] as const),
    'All',
    (shown) => {
      for (const [kind, elements] of groups)
        for (const element of elements) element.hidden = shown !== 'All' && shown !== kind;
    },
  );
  const swatches = new Map<Choice, HTMLButtonElement>();
  for (const [kind, names] of byKind) {
    const title = h('p', { class: 'note' }, kind);
    const grid = h('div', { class: 'swatches' });
    groups.push([kind, [title, grid]]);
    ramps.content.append(title);
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
          choose.selectedIndex = byKind.flatMap(([, n]) => n).indexOf(name);
          restyle();
        },
        { signal: stage.signal },
      );
      swatches.set(name, swatch);
      grid.append(swatch);
    }
    ramps.content.append(grid);
  }

  stage.meter(view);
  rebuild();
  restyle();
  view.fit();
}
