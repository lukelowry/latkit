# Scenes and marks

The [three-bus dataset](data.md) draws a branch between each pair of referenced buses. The bus positions are schematic. Color shows voltage magnitude from 0.98 to 1.02 p.u.

```{literalinclude} ../npm/test/consumer/three-bus.ts
:language: typescript
:start-at: export function voltageDiagram
```

```{image} images/three-bus.png
:alt: Mill links the North and South buses. Color shows the voltage magnitude at each bus.
:class: picture
```

Assign a new scene to `view.scene` to change the drawing. Check `view.failures` if a mark is missing. A title or legend placed on a side reserves space. One placed in a corner overlays the drawing.

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

| To draw                                                         | Use                                         |
| --------------------------------------------------------------- | ------------------------------------------- |
| A bus, device symbol, or gauge                                  | `vertices` with a position and marker       |
| A branch between two bus IDs                                    | `edges` with two reference fields in `ends` |
| A drafted [one-line](examples/hawaii.md) or geographic boundary | `lines` with path geometry                  |
| A [rotor speed trace](examples/frequency.md)                    | `lines` with a sampled field in `trace`     |
| A filled region                                                 | `areas` with polygon geometry               |

A mark reads its table and dataset. Set `pick: true` on lines and areas to make them respond to the pointer. Vertices, edges and plot traces support picking by default.

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

A field expression such as `$vm` reads a row's voltage. `null` means missing. Use a fixed colormap domain when comparing voltages across cases or frames.

```ts
import { field, selected, when } from 'latkit';

field('vm').colormap('balance').domain(0.95, 1.05); // bus voltage in p.u.
field('kv').of('from'); // nominal kV at the branch's from bus
when(selected()).then('#ffb000').otherwise('#8392a5'); // highlight selected rows
```

Use `units()` for dimensions that scale with zoom. Plain numbers specify CSS pixels. The [expression reference](reference/api.md#expressions) lists the builders, operators and colormaps.

## Custom shaders

Use `shade` to change a mark's pixel color, or `marker.wgsl` to draw a custom vertex symbol. Both take WGSL source and up to eight per-row inputs. The shade below brightens branches near the pointer.

```ts
// Lines brighten near the pointer.
const spotlight = `fn shade(f: ShadeFragment) -> vec4f {
  let near = (1.0 - smoothstep(0.0, 200.0, distance(f.px, f.pointer.xy))) * f.pointer.z;
  return vec4f(mix(f.color.rgb, vec3f(1.0, 0.8, 0.4), 0.6 * near), f.color.a);
}`;
const lines = { edges: grid.table('Branch'), ends: ['from', 'to'], shade: { source: spotlight } };
```

If compilation fails, the mark stays hidden. Inspect [view failures](views.md#events) for the shader error.

## Themes, controls, and layouts

- **Theme.** Start with `'light'` or `'dark'`. Override the parts you need, such as `edge.width` or `text.size`.
- **Parallel circuits.** Use `theme.edge.parallel.gap` to space branches that share endpoints. A stroke halo leaves a gap at a crossing.
- **Controls.** Use the default pan and zoom gestures, or bind inputs with `controls.gestures`. Choose `'inspect'` when the application controls the camera.
- **Layout.** Give buses coordinates to preserve a schematic or map. For connectivity alone, use a layered or stress layout.

See the [scene reference](reference/types.md#scene) for the full set of options.
