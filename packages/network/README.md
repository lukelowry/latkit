# @latkit/network

Draw a model's vertices, edges, and paths with WebGPU: flat, tilted, or on a globe.

```sh
npm install @latkit/gpu @latkit/network
```

```ts
import { createGpu } from '@latkit/gpu';
import { createNetwork } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork(gpu, {
  canvas,
  source,
  vertices: {
    Bus: {
      x: 'longitude',
      y: 'latitude',
      color: { field: 'load', colormap: 'viridis' },
      labels: 'name',
    },
  },
  edges: { Line: { ends: ['from', 'to'] } },
});
network.set({ camera: { projection: 'globe' } }, { animate: true });
```

[Guide](https://latkit.readthedocs.io/en/latest/network-quickstart.html) ·
[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/network/index.html)
