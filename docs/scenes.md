# Draw a scene

A scene specifies a space and an ordered list of marks. Add a theme, controls, layout,
title, or transition duration (`ease`, in seconds) as needed. Assign a new scene to
`view.scene`. The view keeps drawing the previous scene while the new shaders compile.
Rows animate from their previous positions. Check `view.failures` for options that could
not be applied.

```ts
const scene: Scene = {
  space: 'earth',
  marks: [
    { edges: grid.table('Branch'), ends: ['from', 'to'], width: 1.5 },
    {
      vertices: grid.table('Bus'),
      position: ['$lon', '$lat'],
      radius: units('$kv', { atLeast: 2 }),
      color: field('vm').colormap('balance').domain(0.95, 1.05),
      label: when(field('kv').ge(230)).then(field('name')).otherwise(null),
      legend: { title: 'Voltage', unit: ' pu', place: 'right' },
    },
  ],
  theme: { base: 'light', vertex: { radius: 4 } },
  controls: 'inspect',
  title: { text: 'Grid', subtitle: 'Bus voltages', place: 'top' },
};
```

Put a title or legend in a corner to overlay it, or on a side to reserve space for it.
Plots default to the top and right sides. Other spaces use the top-left and bottom-right
corners. A pointer over a title or legend cannot pick a row beneath it.

See the [scene reference](reference/types.md#scene) for placement, sizing, and defaults.

## Spaces

| Space     | Positions                                              |
| --------- | ------------------------------------------------------ |
| `'plane'` | plane units with elevation; the camera turns and tilts |
| `'earth'` | longitude and latitude in degrees, on a map or a globe |
| `'plot'`  | the axis coordinate across, values up                  |

Write a space as an object to give it options: `{ earth: { projection: 'globe' } }`,
`{ plane: { grid: { lines: { step: 10 } } } }`, or a plot's `{ plot: { x, y } }` axes. A plane's y
grows up the screen, or with `{ plane: { y: 'down' } }`, down it.

## Marks

A mark's kind key holds the table it draws: `{ vertices: grid.table('Bus') }`. A view loads every
dataset its marks draw from. `JSON.stringify` writes a table as `[data, table]`, the form the
command line reads, where `data` names one of the view's `sources`. The pointer hovers and clicks
vertices, edges, and a plot's traces. Set `pick: true` to make areas and lines respond too.
Either way, every mark shows which of its rows are selected and hovered.

| Mark       | Draws each row as                                                        |
| ---------- | ------------------------------------------------------------------------ |
| `vertices` | a marker at `position` (or at the point field `geometry`)                |
| `edges`    | a stroke between the two rows its `ends` fields reference                |
| `lines`    | a stroke along a path field; on a plot, a sampled field traced over time |
| `areas`    | the area a polygon field covers                                          |

Use `marker` to choose a vertex shape, icon, or symbol. Set `bearing` in degrees clockwise
from up. Use `marker: 'none'` for a label alone.

Edges join vertex centers by default. Set `meet: 'nearest'` to end the edge at the nearest
point on each marker. An edge inherits its endpoint colors unless you set its color. Use
`blend: 0.5` for a sharp change halfway along the edge. Add up to four stroke markers with
`markers`. Each marker's `at` runs from 0 at the start to 1 at the end.

Use `flow` to show direction along a stroke. Negative speeds reverse the comets. Set their
spacing, length, and width in `theme.flow`. For a net that connects several vertices, use
`joins: [table, reference]`. On a plot, use `trace` to draw a sampled field over time.
For example, `trace: field('vm').mul(100)` converts per-unit voltage to percent.

Set `label` to a text field or an expression. Missing values hide the label.
When labels overlap, the row drawn on top takes priority. For a live numeric label, use
`label: { text: field('vm'), precision: 3, unit: ' pu' }`.
See [Edges](reference/types.md#edges), [StrokeMarker](reference/types.md#strokemarker),
and [Label](reference/types.md#label) for the remaining options.

## Expressions

Options that vary by row take an expression: a number, a boolean, a string, `null`, or a builder.
A string `'$name'` reads field `name`. Any other string is a CSS color. To color by a field, pass it
through a colormap or a conditional. `null` is a missing value, and an option that evaluates to
missing takes the theme's value.

```ts
import { field, when, selected, zoom, units } from 'latkit';

field('load').div(field('capacity')).clamp(0, 1); // arithmetic and comparisons
field('vm').colormap('balance').domain(0.95, 1.05); // a color through a colormap
field('vm').colormap('viridis').domain('all'); // over every value, in every frame
field('kv').scale(2, 8); // onto a range
field('kv').match([
  [69, 1.5],
  [138, 2.5],
]); // a result for each value, a number or a text
field('rating').fallback(100); // another value where one is missing
when(selected()).then('#ffb000').otherwise(field('kind').colormap('tableau10')); // colors
when(zoom().ge(6)).then(field('name')).otherwise(null); // a label's text, from zoom 6 on
units('$radius', { atLeast: 2 }); // a size in position units, kept within pixels
field('vm').from(weather.table('Station')); // read from another dataset, joined by id
field('kv').of('from'); // read from the row a reference names, such as an edge's first bus
```

A categorical colormap takes each value's whole part as its category, or with `values`, the place
among them of the one it equals: `{ kind: 'categorical', values: ['gas', 'wind'], colors }` colors
a text field. A legend then draws each category as its mark draws rows: a stroke at its width, or a
marker's shape.

Sizes are in CSS pixels. Wrap a size in `units()` to give it in position units, which scale with
the zoom. State expressions read the view: `selected()`, `hovered()`, `related()` (one
reference from a selected or hovered row), `pointer()`, `elapsed()`, and `zoom()`. `colormaps()`
lists the colormap catalog with each map's colors, and `colormapCss(map)` returns a colormap as a
CSS gradient, for legends drawn in HTML.

## Custom shaders

Where an expression can't say how a mark looks, two options take WGSL:

- A vertex mark's `marker: { wgsl: { source, inputs } }` draws each marker. `source` defines
  `fn marker(f: MarkerFragment) -> MarkerColor`, which returns the pixel's color and its signed
  distance from the outline, so glows and status rings follow the shape. The color's alpha is the
  pixel's coverage, blended as given: fade the edge yourself, as
  `color.a * saturate(0.5 - distance / fwidth(distance))` does.
- Any mark's `shade: { source, inputs }` colors each pixel before it blends. `source` defines
  `fn shade(f: ShadeFragment) -> vec4f`. It reads the pixel (`f.px`, and `f.local` within its row's
  shape), the pointer (`f.pointer`), and the time (`f.elapsed`). A shade that reads the time draws
  every frame, and one that reads the pointer draws as it moves.

Both read up to eight `inputs`, expressions evaluated for each row, as `f.input[i]`. They change
color only: hover and picks follow the rows' shapes.

```ts
// Lines brighten near the pointer.
const spotlight = `fn shade(f: ShadeFragment) -> vec4f {
  let near = (1.0 - smoothstep(0.0, 200.0, distance(f.px, f.pointer.xy))) * f.pointer.z;
  return vec4f(mix(f.color.rgb, vec3f(1.0, 0.8, 0.4), 0.6 * near), f.color.a);
}`;
const lines = { edges: grid.table('Line'), ends: ['from', 'to'], shade: { source: spotlight } };
```

The source may declare its own functions, types, and constants, and sees only the struct it reads.
It compiles once, the first time a view draws it. Source that does not compile is the mark's
failure (see [Events](views.md#events)), and the mark draws nothing.

## Themes, controls, and layouts

- `theme` is `'dark'`, `'light'`, or overrides of a base theme, grouped by what they style:
  `{ base: 'light', text: { size: 12 }, edge: { width: 2 } }`.
- Edges joining the same two vertices run side by side, `edge.parallel.gap` apart: pixels, the same
  at any zoom, or `units(n)`. `converge` sets how they meet their vertices: `'squeeze'` fits them within the smaller
  vertex, `'fan'` angles them in to each vertex's center, and `'straight'` stops each at its
  vertex's outline. `parallel: null` draws them over one another.
- `edge.halo` and `line.halo` draw a band of the background's color beside each stroke, which
  covers the strokes drawn under it, so a stroke that crosses another parts it. They, `text.halo`,
  `dash`, and `vertex.corner` take pixels or `units(n)`.
- `controls` sets what the pointer and keys do. By default the pointer pans, zooms, turns, and
  hovers. `gestures` binds each input to what it does, as in
  `{ gestures: { wheel: 'pan', 'control+wheel': 'zoom', 'shift+primary': 'box' } }`. `'inspect'`
  leaves the camera to your application, and `'none'` suits a still picture.
- `layout` places vertex rows that have no position among the rows they link to by edges or nets:
  `'stress'` or `'layered'`. A row keeps its place once laid out.
