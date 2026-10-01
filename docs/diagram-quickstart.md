# Diagram

`@latkit/diagram` renders native model components, ports, and connections using the
shared GPU renderer interface.

```ts
import { createGpu, createCanvasView } from '@latkit/gpu';
import { createDiagram, attachDiagramInput } from '@latkit/diagram';

const gpu = await createGpu();
const diagram = createDiagram({
  gpu,
  data: {
    source: model,
    components: { Task: { labels: { field: 'name' } } },
    connections: { Dependency: { arrows: ['target'] } },
  },
});
const view = createCanvasView({ gpu, renderer: diagram, canvas, onError: console.error });
const detach = attachDiagramInput({ diagram, canvas, interaction: 'edit' });
view.request();
```

Give the canvas an explicit CSS size. Type names, fields, ports, and endpoint roles
come from your model schema. The application accepts editing proposals and owns
persistence and undo. Destroy input, view, renderer, and GPU in that order.

See the [package guide](../packages/diagram/README.md) for layout, grouping, field
bindings, routing strategies, interaction, and offscreen rendering.
