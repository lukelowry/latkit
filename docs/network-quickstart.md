# Network

Draw a model's vertices, edges, and paths: flat, tilted, or on a globe.

```ts
import { createNetwork } from '@latkit/network';

const network = createNetwork(gpu, {
  canvas,
  source,
  vertices: {
    Bus: { color: { field: 'load', domain: [0, 1], colormap: 'viridis' }, labels: 'name' },
  },
  edges: { Line: { ends: ['from', 'to'] } },
});
```

Each `Bus` is drawn at its type's spatial field; each `Line` row references the two buses it joins
through `from` and `to`. [Data bindings](topology-and-channels.md) covers nets, paths, and styling
by field.

## Camera

```ts
network.set({ camera: { projection: 'globe', orbit: true } }, { animate: true });
```

The camera is `{ projection, center, scale, pitch, bearing, fit, orbit }`. The globe needs
geographic positions; `network.projections` says which projections the data supports.

Drag to pan, right- or Shift-drag to turn, and scroll to zoom. Shift-, Ctrl-, or ⌘-click adds to the
selection. Home fits; arrows pan, or step between neighbors with `input: 'inspect'`.

## Style

Style options sit on the config beside the data:

```ts
network.set({ edgeWidthPx: 2, showGraticule: true, daylight: true, sunTime: Date.now() });
```

Omitted domains fit the displayed values; give a `domain` for stable colors during playback.

[API](https://latkit.readthedocs.io/en/latest/api/reference/network/index.html)
