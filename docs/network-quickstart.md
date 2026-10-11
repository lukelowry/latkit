# Network

Draw a model's vertices and edges: flat, tilted, or on a globe, over a map.

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

Each `Bus` draws at its `longitude` and `latitude`, which the schema marks `geographic`. Each
`Line` joins the two buses its `from` and `to` fields reference. Nets and channels are under
[data bindings](topology-and-channels.md), and what every view shares is under [views](views.md).

## Camera

```ts
network.set({ camera: { projection: 'globe', orbit: true } });
```

Geographic positions start on the mercator plane, as a [geography](geography-quickstart.md) does,
and others on the flat plane. The globe needs geographic positions; `network.projections` says
which projections the data supports.

Drag pans, and right- or Shift-drag turns, tilting a flat camera. Arrows pan and Shift-arrows turn.
Under `input: 'inspect'`, arrows step the selection to its neighbor in that direction.

An edge between geographic points takes the shortest way over the earth: along the great circle on
the globe, and straight in longitude and latitude on a flat map. `route: 'straight'` or
`'geodesic'` holds one on every projection.

## Map beneath

```ts
const ground = createGeography(gpu, { source: borders, lines: { Border: {} } });
network.set({ ground });
```

A [geography](geography-quickstart.md) draws the earth beneath the graph, in the same pass, and its
sun lights the graph too. Without a ground, `grid: true` draws lines of the data's x and y beneath
the graph; over one, the ground's own `grid` draws instead.

## Layout

A vertex without a position is placed by `'stress'`, each edge as long as the median of the
positioned ones. See [layout](views.md#layout).

```ts
network.set({ layout: { vertexGap: 0.5 } }); // places them anew
```

## Markers

A vertex type's `marker` decides what draws in each row's radius: a disc by default.

```ts
import { gauge, icon, pie, shape, type Marker } from '@latkit/gpu';

vertices: {
  Plant: { marker: gauge({ fill: 'output' }) }, // a ring, and a wedge of output inside
  Load: { marker: gauge({ fill: 'served', shape: 'rounded' }) }, // a bar from the bottom
  Mix: { marker: pie({ slices: ['coal', 'gas', 'wind'], colors: [brown, gray, teal], hole: 0.5 }) },
  Site: { marker: icon({ images: [plant, substation], image: 'kind' }) },
  Tap: { marker: shape('diamond') },
}
```

A marker of your own is WGSL defining `fn marker(f: MarkerFragment) -> MarkerColor`. `f.p` is the
pixel's offset from the vertex in CSS pixels, y up. `f.radiusPx` and `f.color` are the row's, and
each of up to eight `inputs` is a channel read as `f.<name>`. The function returns a color whose
alpha is its coverage, as `filled(color, distance)` gives, and the signed distance to its outline,
which glows and shadows follow. Holes go in the alpha alone. The shared `shapeDistance`, `filled`,
`over`, `gaugeMarker`, `pieMarker`, and `markerImage` compose:

```ts
const station: Marker = {
  inputs: { fill: 'output', load: 'isLoad' },
  steps: ['load'], // changes at once; other inputs ease
  wgsl: `fn marker(f: MarkerFragment) -> MarkerColor {
    return gaugeMarker(f, select(SHAPE_ELLIPSE, SHAPE_ROUNDED, f.load > 0.5), f.fill, 2.0, 1.5);
  }`,
};
```

## Motion

```ts
setInterval(() => network.set({ source: next() }, { animate: true }), 500);
```

An animated patch eases on the GPU, so a wedge sweeps and a color crosses over. New rows ease in
from nothing, and a transition the GPU budget cannot hold steps instead. `flowPx` moves comets
along an edge, and a new speed carries on from where they are. Hover grows a vertex by
`hoverScale`. Reduced motion also holds comets still and stops orbiting.

## Style

```ts
network.set({ edgeWidthPx: 2, shadows: true });
```

Style options sit on the config beside the data; [views](views.md#style) lists the shared ones. By
default an edge takes the colors of the vertices it joins (`edgeColor: 'ends'`).

Selected and hovered rows draw again over everything but labels, lit by their glow, so a crowded
region never covers them. `selectedEnds` and `hoverEnds` also draw the vertices a focused edge joins
over the rest.

## Limits

`pick` and hover query hit-test indexes on every projection, built in the background once the
positions and the camera hold still. They take about 21 bytes per vertex or edge, so the default
64 MiB `limits.pickingBytes` fits a million vertices and two million edges. Past that, or while `z`
raises rows, they scan every item.

[API](https://latkit.readthedocs.io/en/latest/api/reference/network/index.html)
