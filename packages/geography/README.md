# @latkit/geography

Draw the earth and what lies on it with WebGPU: ground, areas, lines, and labels from Data,
GeoJSON, or vector tiles, flat or on a globe, alone or beneath a network.

```sh
npm install @latkit/gpu @latkit/geography
```

```ts
import { createGpu } from '@latkit/gpu';
import { createGeography, tiles } from '@latkit/geography';

const gpu = await createGpu();
const geography = createGeography(gpu, {
  canvas,
  source: tiles('https://tiles.openfreemap.org/planet'),
  areas: { water: { color: [0.05, 0.1, 0.17, 1] } },
  lines: { boundary: { widthPx: 1, dash: true } },
  camera: { projection: 'globe' },
});
```

[Guide](https://latkit.readthedocs.io/en/latest/geography-quickstart.html) ·
[Views](https://latkit.readthedocs.io/en/latest/views.html) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/geography/index.html)
