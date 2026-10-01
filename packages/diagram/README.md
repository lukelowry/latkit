# @latkit/diagram

Declaration-only public skeleton for the diagram rewrite. The root exports TypeScript declarations;
there is deliberately no runtime export or placeholder implementation. Build emits `.d.ts` files.
The package stays private until the rewrite lands.

[`legacy/`](legacy) holds the previous implementation, its tests and its example as the migration
source. Nothing builds, typechecks, lints or tests it, and it is not a compatibility path.

Sources and `Gpu` are borrowed. Presentation uses `createCanvasView`; offscreen work uses `gpu.render`.
Destroying a renderer releases its own resources and subscriptions, never its sources or GPU owner.
All package imports use roots. Native model data and GPU field, text, color and resource plumbing
are the implementation boundary; no renderer-owned data format, atlas, device pool, or frame loop.

## Target usage

```ts
import { arrange, createDiagram, attachDiagramInput } from '@latkit/diagram';
import { createCanvasView } from '@latkit/gpu';

const data = {
  source: model,
  components: { node: { labels: { field: 'name' } } },
  connections: { link: { route: 'orthogonal' as const } },
};
const positions = await arrange({
  data,
  measureText: (input, options) => gpu.measureText(input, options),
});
const diagram = createDiagram({
  gpu,
  data: { ...data, components: { node: { ...data.components.node, position: positions.node } } },
});
const view = createCanvasView({ gpu, renderer: diagram, canvas, onError });
const detach = attachDiagramInput({ diagram, canvas, interaction: 'edit' });
diagram.on('delete', (ids) => app.remove(ids));
```

Implementation still required: bounded native topology preparation, component/port geometry,
orthogonal routing, grouping, layout, drag/connect gestures, spatial picking and accessibility.
Layouts are indexed native `FieldValues`; stable IDs identify editing proposals. The host decides
whether to apply a domain edit and where to persist presentation positions/groups. Schema ports
and endpoint roles remain model semantics. An arrange operation neither acquires a GPU nor edits
a document; it consumes the injected shared shaped-text metrics.

The compile-checked [consumer fixture](tests/contract.ts) checks this boundary. Drawing uses shared
fields, scales, text/atlas, strokes, effects and submission; geometry and routing belong here.
