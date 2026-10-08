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
diagram.on('delete', (rows) => remove(rows));
```

The diagram proposes edits; your application changes the model, and the diagram redraws from it.
Proposals name rows as items, and `itemId(row)` from `@latkit/model` gives a row's id. Sizes ending
in `Px` are CSS pixels; the rest are diagram units, which zoom with the blocks. [Views](views.md)
covers what every view shares.

## Ports and wires

Each reference field of a vertex that names a drawn net is a port, oriented by the field's
`direction`. A net wires every port that names it; an edge with `ends` wires two vertices. A type's
`ports` options style each port.

## Layout

A vertex with `x` and `y` stays at them; [layout](views.md#layout) places the rest, `'layered'` by
default. A group is arranged inside first, then moves as one vertex of its parent.

```ts
diagram.set({ layout: { direction: 'down' } }, { animate: true });
const positions = await arrange(gpu, config); // { x, y } by type, without drawing
diagram.set({ vertices: { Task: positions.Task } }); // pinned where arranged
```

Writing a move's `positions` keeps every block where it is drawn, the ones the layout placed
included. Collapsing a group routes its wires to its boundary.

## Input

`input: 'edit'` adds editing to navigation. Drag a block to move it, drag from a port or Alt-drag
from a block to wire, drag the background to select, and press Delete to propose removal. Arrows
nudge selected blocks by `gridPitch`, and otherwise pan. Space-drag pans, Shift-drag selects while
navigating too, and Tab visits vertices.

[API](https://latkit.readthedocs.io/en/latest/api/reference/diagram/index.html)
