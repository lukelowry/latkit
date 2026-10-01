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
    vertices: {
      Bus: {
        position: 'position',
        color: { field: 'load', domain: [0, 1], colormap: colormaps.viridis },
        labels: { field: 'name', maxCount: 100 },
      },
    },
    edges: { Line: { ends: ['from', 'to'] } },
  },
});
const view = createCanvasView({ gpu, canvas, renderer: network, onError: console.error });
const detach = attachNetworkInput({ network, canvas });
view.request();
```

`source` is a `Queryable`: `Bus.position` is its geographic spatial field,
`Bus.load` is numeric, and each `Line` row references the two buses it joins
through `from` and `to`.

## Update a view

```ts
network.setVertex('Bus', { size: { field: 'load', domain: [0, 1], range: [3, 12] } });
network.on('select', (items) => console.log(items));
view.request({ at: 12 }); // Native model coordinate.
```

Omit `ends` to draw a type as a net, a star of the vertices that reference it.
Optional `bends` and path `points` are lists of two-component vectors. Set
`curve: 'geodesic'` for geographic arcs. Paths are decorative unless `pickable: true`.

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
