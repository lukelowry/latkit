# @latkit/diagram

Draw a model as blocks and wires with WebGPU: vertices with ports, edges, and groups, laid out,
routed, and editable.

```sh
npm install @latkit/gpu @latkit/diagram
```

```ts
import { createGpu } from '@latkit/gpu';
import { createDiagram } from '@latkit/diagram';

const gpu = await createGpu();
const diagram = createDiagram(gpu, {
  canvas,
  input: 'edit',
  source: model,
  vertices: { Task: { labels: 'name' } },
  edges: { Dependency: { ends: ['from', 'to'], arrows: true } },
});
diagram.on('move', ({ positions }) => savePositions(positions));
```

[Guide](https://latkit.readthedocs.io/en/latest/diagram-quickstart.html) ·
[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/diagram/index.html)
