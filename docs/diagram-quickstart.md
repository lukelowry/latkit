# Diagram

`@latkit/diagram` renders native model vertices, ports, and edges using the
shared GPU renderer interface.

```ts
import { createGpu, createCanvasView } from '@latkit/gpu';
import { createDiagram, attachDiagramInput } from '@latkit/diagram';

const gpu = await createGpu();
const diagram = createDiagram({
  gpu,
  data: {
    source: model,
    vertices: { Task: { labels: { field: 'name' } } },
    edges: { Dependency: { ends: ['from', 'to'], arrows: true } },
  },
});
const view = createCanvasView({ gpu, renderer: diagram, canvas, onError: console.error });
const detach = attachDiagramInput({ diagram, canvas, interaction: 'edit' });
view.request();
```

Give the canvas an explicit CSS size. Type names and fields come from your model
schema; a vertex's reference fields that name a drawn net are its ports. The
application accepts editing proposals and owns persistence and undo. Destroy
input, view, renderer, and GPU in that order.

See the [package guide](https://github.com/lukelowry/latkit/blob/main/packages/diagram/README.md)
for layout, grouping, field bindings, routing strategies, interaction, and offscreen rendering.
