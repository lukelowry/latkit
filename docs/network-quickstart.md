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

Drag to pan, right- or Shift-drag to turn, and scroll to zoom. Shift-, Ctrl-, or ⌘-click toggles an item
in the selection. Home fits; arrows pan, or step between neighbors with `input: 'inspect'`.

## Layout

A vertex without a position is placed by `'stress'` among the vertices it joins, each edge as long
as the positioned ones' median; see [layout](views.md#layout).

```ts
network.set({ layout: { vertexGap: 0.5 } }); // places them anew
const positions = await arrange(gpu, config); // { x, y } by type, without drawing
```

## Markers

A vertex type's `marker` decides what draws in each row's radius: a disc by default.

```ts
import { gauge, icon, pie, shape } from '@latkit/gpu';

vertices: {
  Plant: { marker: gauge({ fill: 'output' }) }, // a ring, and a wedge of output inside
  Load: { marker: gauge({ fill: 'served', shape: 'rounded' }) }, // a bar from the bottom
  Mix: { marker: pie({ slices: ['coal', 'gas', 'wind'], colors: [brown, gray, teal], hole: 0.5 }) },
  Site: { marker: icon({ images: [plant, substation], image: 'kind' }) },
  Tap: { marker: shape('diamond') },
}
```

A marker of your own is WGSL defining `fn marker(f: MarkerFragment) -> MarkerColor`: `f.p` is the
pixel in CSS pixels from the vertex, y up, `f.radiusPx` its radius, `f.color` its color, and each of
up to eight `inputs` a channel read as `f.<name>`. It returns its color, each layer covered as
`filled(color, distance)` covers it, and the signed distance to its outline, which glows and shadows
follow; a hole, such as a gauge's gap or a pie's middle, is in the alpha alone and shows what lies
below. The shared shapes and markers, `shapeDistance`, `filled`, `over`, `gaugeMarker`,
`pieMarker`, and `markerImage`, compose:

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

`set(patch, { animate: true })` eases what the patch changes over `animationMs`: positions, colors,
sizes, widths, flow, and marker inputs, all on the GPU, so a wedge sweeps and a color crosses over;
a row new to the drawing eases in from nothing, and a transition the GPU budget cannot hold steps.
An edge's or path's `flowPx` moves comets along it, `flowSpacingPx` apart, and a new speed carries on
from where they are. Hover grows a vertex by `hoverScale`. Under reduced motion, changes step and
comets hold still.

```ts
setInterval(() => network.set({ source: next() }, { animate: true }), 500);
network.set({ shade: pulse({ color: [1, 0.1, 0.1] }) }); // rows whose `shade` is positive pulse
```

## Style

Style options sit on the config beside the data:

```ts
network.set({ edgeWidthPx: 2, grid: true, daylight: true, sunTime: 'now' });
```

`markers`, `lines`, `poles`, `grid`, and `earthAxis` show or hide each layer. A kind's defaults are
named after the channels they stand in for: `vertexColor`, `vertexRadiusPx`, `edgeColor` (`'ends'`
colors an edge by the vertices it joins), `edgeWidthPx`, `pathColor`, and `pathWidthPx`; `zScale`
sets how high a `z` of 1 draws. `edgeSpacingPx` draws edges joining the same two vertices apart,
straight or geodesic, while a type with `bends` follows its own routes; `shadows` lifts markers off
the lines, and `labelHaloPx` sets the halo around labels, in the color of the ground they lie on.
Selected and hovered rows draw again over everything but labels, lit by their glow, so a crowded
part of the drawing never covers them; `selectedEnds` and `hoverEnds` draw the vertices a focused
edge joins over the rest too. The options every view shares, such as `background`, `selectedColor`,
and `unselectedAlpha`, are listed under [views](views.md#style).
Omitted domains fit the displayed values; give a `domain` for stable colors during playback.

## Limits

`limits: { vertices, segments, geometryBytes, pickingBytes, layoutMs }` bound what a network reads,
keeps, and spends placing vertices.
On a flat camera, `pick` and hover query hit-test indexes, about 21 bytes per vertex or edge, built
in the background once positions hold still; the default 64 MiB `pickingBytes` fits a million
vertices and two million edges. Past it, they scan every item.

[API](https://latkit.readthedocs.io/en/latest/api/reference/network/index.html)
