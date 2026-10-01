# Create a network view

Interactive WebGPU views over native model data.

```ts
import { createGpu, createCanvasView, colormaps } from '@latkit/gpu';
import { createNetwork, attachNetworkInput } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork({
  gpu,
  data: {
    source,
    coordinates: 'geographic',
    vertices: {
      node: {
        position: 'position',
        color: { field: 'load', domain: [0, 1], colormap: colormaps.viridis },
        labels: { field: 'name', maxCount: 100 },
      },
    },
    edges: { line: { connectivity: { kind: 'endpoints', layout: 'pair' } } },
  },
});
const view = createCanvasView({ gpu, canvas, renderer: network, onError: console.error });
const detach = attachNetworkInput({ network, canvas });
view.request();
```

`source` is a `Queryable`: `node.position` contains longitude/latitude vectors,
`node.load` is numeric, and `line` exposes endpoint connectivity.
Use `coordinates: 'cartesian'` for planar coordinates.

## Update a view

```ts
network.setVertex('node', { size: { field: 'load', domain: [0, 1], range: [3, 12] } });
network.on('select', (items) => console.log(items));
view.request({ at: 12 }); // Native model coordinate.
```

Use `layout: 'star'` for connections with several endpoints. Optional `bends`
and path `points` are lists of two-component vectors. Set `curve: 'geodesic'`
for geographic arcs. Paths are decorative unless `pickable: true`.

Omitted color/size domains use finite values over the displayed mapping.
Use an explicit domain for stable playback colors. Selection keeps native
source, index, and row identities.

## Cleanup

```ts
detach();
view.destroy();
network.destroy();
gpu.destroy();
await source.close();
```

The renderer borrows the source and GPU; its destruction closes neither.

[Data bindings](topology-and-channels.md) ?
[API](https://latkit.readthedocs.io/en/latest/api/reference/network/index.html)
