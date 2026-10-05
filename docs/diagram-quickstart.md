# Diagram

Draw a model as blocks and wires: vertices with ports, edges, and groups, laid out or placed.

```ts
import { createDiagram } from '@latkit/diagram';

const diagram = createDiagram(gpu, {
  canvas,
  input: 'edit',
  source: model,
  vertices: { Task: { labels: 'name' } },
  edges: { Dependency: { ends: ['from', 'to'], route: 'orthogonal', arrows: true } },
});
diagram.on('move', ({ positions }) => savePositions(positions));
diagram.on('connect', (proposal) => wire(proposal));
diagram.on('delete', (ids) => remove(ids));
```

The diagram proposes edits; your application changes the model, and the diagram redraws from it.
Proposals name rows by `{ type, id }`.

## Ports and wires

A vertex's reference fields that name a drawn net are its ports, oriented by the field's
`direction`. An edge with `ends` joins two vertices; a net fans out to every port that names it.
`ports` options set a port's side, order, label, color, status, and marker.

## Layout

A vertex with `x` and `y` stays where they put it; `layout` places the rest. Vertices that edges
join form a part, arranged on its own by `algorithm` (`'layered'`, or a `LayoutStrategy` called
once per part), and the parts nothing pins pack into rows of about `aspect` (16 / 9) below the
pinned ones. A group is arranged inside first, then moves as one vertex of its part.

```ts
diagram.set({ layout: { direction: 'down' } }, { animate: true });
const positions = await arrange(gpu, config); // { x, y } by type, without drawing
diagram.set({ vertices: { Task: positions.Task } }); // pinned where arranged
```

A move proposes the drawing as it stands: each dragged vertex and each the layout placed, so
writing `positions` keeps every block where it is drawn. Collapsing a group routes its wires to its
boundary, and moving it moves its vertices.

## Input

`input: 'edit'` adds dragging, marquee selection, wiring, and Delete to navigation; `'inspect'`
keeps page scrolling. Pass `{ mode, backgroundDrag, connectRadiusPx, autoPan, canConnect }` to tune
it. Tab visits vertices, Enter opens, Home fits, and arrows pan or nudge the selection. Space-drag
pans, two pointers pinch, a long press opens the context menu, and Escape ends a drag before it
clears the selection.

The camera, selection, hover, `pick`, and `fit` work as in every [view](views.md): `fit(items)`
frames them once, and `fit()` follows the whole diagram.

Geometry, text, and gaps use diagram units; widths, radii, and padding use CSS pixels.

[API](https://latkit.readthedocs.io/en/latest/api/reference/diagram/index.html)
