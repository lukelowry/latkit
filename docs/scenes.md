# Scenes

A scene is plain data: a `space`, `marks` drawn in order, and optionally a `layout`, `theme`,
`controls`, `ease` (seconds changes ease over), and a `title` and `subtitle`. A view shows a scene;
`view.show(next)` replaces it, keeping every row's place in the transition.

```ts
const scene: Scene = {
  space: 'mercator',
  marks: [
    { edges: { of: ['grid', 'Branch'], ends: ['from', 'to'], width: 1.5 } },
    {
      vertices: {
        of: ['grid', 'Bus'],
        position: ['lon', 'lat'],
        radius: units('kv', { atLeast: 2 }),
        color: field('vm').colormap('balance').domain(0.95, 1.05),
        label: { text: 'name', priority: 'kv' },
        legend: 'Voltage (pu)',
      },
    },
  ],
  theme: { base: 'light', vertexRadius: 4 },
  controls: 'inspect',
};
```

## Spaces

| Space                   | Positions                                                         |
| ----------------------- | ----------------------------------------------------------------- |
| `'plane'`               | plane units with elevation; the camera turns and tilts            |
| `'mercator'`, `'globe'` | longitude and latitude in degrees, on a map or a globe            |
| `'plot'`                | the axis coordinate across, values up                             |
| `'diagram'`             | a flat sheet, y down, every length a unit; ports, groups, layouts |

Each takes options as `{ plane: { grid } }`, `{ diagram: { grid } }`, `{ earth: { projection,
surface, graticule, daylight, atmosphere } }`, or `{ plot: { x, y } }`. A grid is `'off'`,
`{ lines: { pitch } }`, or `{ dots: { pitch, snap } }`.

## Marks

Every mark names its table, `of: [dataset, table]`, and takes `color`, `visible`, `priority`,
`label`, `legend`, `shadow`, `name`, and `pick`, `select`, and `drag`. Unless `pick` says, rows
that are things are hovered, clicked, and probed (vertices, edges, faces, a plot's traces) and
geometry is not (areas, and lines along paths: coasts, borders, roads), so hovering probes none of
it; `pick: true` makes a map's states or cells answer the pointer.

| Mark       | Draws each row as                                                  | Its own options                                                      |
| ---------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `vertices` | a marker at `position` (or the point field `geometry`)             | `elevation`, `radius`, `size`, `marker`, `ring`, `ports`, `contains` |
| `edges`    | a stroke between the rows two reference fields name                | `ends`, `bends`, `route`, `arrows`, `width`, `dash`, `flow`          |
| `lines`    | a path field's stroke; on a plot, a sampled field traced over time | `geometry`, `trace`, `interpolation`, `width`, `dash`, `flow`        |
| `areas`    | the area a polygon field covers                                    | `geometry`                                                           |
| `faces`    | a triangle between three vertices                                  | `corners`                                                            |

A `flow` sends comets along a stroke. In a diagram, vertices are blocks with `ports`, a vertex mark
with `contains` draws groups around the rows that name it, and edges of a table without `ends` are
nets joining the ports that name them.

## Expressions

Options that vary by row take expressions: a number, a field name, a `#hex` color, or a builder.

```ts
import { field, when, units } from 'latkit';

field('load').div(field('capacity')).clamp(0, 1); // arithmetic and comparisons
field('vm').colormap('balance').domain(0.95, 1.05); // through a colormap
field('kv').scale(2, 8); // onto a range
when(field('alarm').gt(0.5)).then('#ffb000').otherwise(field('kind').colormap('tableau10'));
units('radius', { atLeast: 2 }); // a size in position units, kept within pixels
field('vm').of('weather', 'Station'); // read from another dataset, joined by id
```

`elapsed()` reads the view's clock. Hover and selection glow through the focus styles, and sizes in
pixels hold across zoom.
Colormaps are a catalog name or your own colors, `{ kind, colors }`; a categorical map can name its
`categories` for its legend. `colormapCss(map)` gives the same colors as a CSS gradient.

## Themes, controls, and layouts

- **Theme**: `'dark'`, `'light'`, or options over a base, `{ base: 'light', fontSize: 12 }`. `edge:
null` blends each edge's ends' colors, and `selected: null` glows in each row's own color.
- **Controls**: `'inspect'` (the default), `'none'`, or options: `pan`, `zoom`, `turn`,
  `keyboard`, `hover`, `pickRadius`, `selectBox`, `connect`, `delete`, `cycle`, `press`, `motion`.
- **Layout** places vertex rows without positions: `'stress'`, `'layered'`, or their options. A
  place, once given, holds; `view.arrange()` lays every row out again.
