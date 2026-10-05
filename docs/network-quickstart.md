# Network

Draw a model's vertices, edges, and paths: flat, tilted, or on a globe.

```ts
import { createNetwork } from '@latkit/network';

const network = createNetwork(gpu, {
  canvas,
  source,
  vertices: {
    Bus: {
      x: 'longitude',
      y: 'latitude',
      color: { field: 'load', domain: [0, 1], colormap: 'viridis' },
      labels: 'name',
    },
  },
  edges: { Line: { ends: ['from', 'to'] } },
});
```

Each `Bus` is drawn at its `longitude` and `latitude` fields, which the schema marks `geographic`; each `Line` row
references the two buses it joins through `from` and `to`. [Data bindings](topology-and-channels.md) covers nets, paths, and styling
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
network.set({ edgeWidthPx: 2, grid: true, daylight: true, sunTime: 'now' });
```

`markers`, `lines`, `poles`, `grid`, and `earthAxis` show or hide each layer. A kind's defaults are
named after the channels they stand in for: `vertexColor`, `vertexRadiusPx`, `edgeColor` (`'ends'`
colors an edge by the vertices it joins), `edgeWidthPx`, `pathColor`, and `pathWidthPx`; `zScale`
sets how high a `z` of 1 draws. The options every
view shares, such as `background` and `selectedColor`, are listed under [views](views.md#style).
Omitted domains fit the displayed values; give a `domain` for stable colors during playback.

## Limits

`limits: { vertices, segments, geometryBytes, pickingBytes }` bound what a network reads and keeps.
On a flat camera, `pick` and hover query hit-test indexes, about 21 bytes per vertex or edge, built
in the background once positions hold still; the default 64 MiB `pickingBytes` fits a million
vertices and two million edges. Past it, they scan every item.

[API](https://latkit.readthedocs.io/en/latest/api/reference/network/index.html)
