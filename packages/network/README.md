# @latkit/network

WebGPU network renderer for Latkit.

## Install

```sh
npm install @latkit/gpu @latkit/network @latkit/colormaps
```

## Basic use

```ts
import { colormap } from '@latkit/colormaps';
import { requestDevice } from '@latkit/gpu';
import { createNetwork, finiteExtent, type Topology } from '@latkit/network';

const topology: Topology = {
  vertexCount: 3,
  vertexCoords: new Float32Array([-96, 30, -95, 31, -94, 30]),
  edges: new Uint32Array([0, 1, 1, 2]),
  polylineStart: new Uint32Array([0, 0, 0]),
};

const device = await requestDevice();
const canvas = document.querySelector<HTMLCanvasElement>('#network')!;
const network = await createNetwork(device, canvas, {
  colormap: colormap('viridis'),
  graticule: true,
});

network.load(topology);
const values = new Float32Array([0.1, 0.8, 0.4]);
network.setChannel('vertexColor', values, finiteExtent(values));
network.fadeIn();
```

`vertexHeight` orders overlapping geometry by depth in `flat`, then becomes
physical lift continuously as the same planar camera tilts. Switching between
`flat` and `tilt` reuses that camera and its WebGPU pipeline bundle.

Geometry tuning is live and remains relative to topology-derived sizes:

```ts
network.setOptions({
  vertexScale: 1.25, // vertex radius
  edgeScale: 0.8, // edge half-width
  heightScale: 1.5, // vertex-height displacement
  vertexLodPx: 2, // CSS-pixel visibility threshold
  dashPeriodPx: 12, // CSS-pixel edge-dash period; 0 renders solid
});
```

All five options accept non-negative numbers; their defaults are `1`, `1`, `1`, `2`, and `12`.

## Selection and navigation

`Item` is the renderer's stable vertex/edge identity. Selection changes only
the focus ring, `reveal` brings an item into view without changing zoom or
projection, and subset fit deliberately reframes it:

```ts
const item = { kind: 'vertex', index: 1 } as const;

network.select(item.kind, item.index);
network.reveal(item, { paddingPx: 48, animate: true });

// Use only for an explicit "fit item" interaction.
network.fit([item], true);
```

An item already visible inside the reveal padding is left in place. Pass
`{ center: true }` for an explicit centering command. Reveal retains scale, globe
distance, tilt, and bearing; a newer camera command replaces any in-progress
move.

Navigation methods use relative screen-space input. Deltas are CSS pixels and
zoom is multiplicative:

```ts
network.panBy(24, 0);
network.zoomBy(1.2);

network.setProjection('tilt');
network.rotateBy(18, -8);
```

Rotation changes bearing and pitch in `tilt` and is a no-op in projections
without rotation, including `flat` and `globe`.

## Shared view semantics

Higher-level Network consumers can derive their own surfaces without copying renderer vocabulary.
`CHANNEL_DEFINITIONS` and `PROJECTION_MODES` are frozen canonical registries;
`OPTION_DEFINITIONS` and `DEFAULT_OPTIONS` own option names, validation kinds, lifecycles, and
defaults. `validateOption`, `validateOptions`, and `validateChannelRange` expose the same validation
boundary consumed by Network itself, while `finiteExtent` and `validateBorders` cover channel-domain
and geographic-border data.

`createNetwork()` accepts a native Core `GPUDevice` and a caller-owned
`HTMLCanvasElement`. `@latkit/gpu` acquires the device and supplies Network's
shared presentation internals. The caller controls the canvas's placement and
CSS size.

Network borrows both. Destroy the renderer before removing the canvas, and
destroy the device only after every renderer using it has been destroyed:

```ts
network.destroy();
canvas.remove();
device.destroy();
```

## Data shape

- `vertexCoords` stores two numbers per vertex.
- `edges` stores endpoint pairs.
- `polylineStart` stores one offset per edge plus a terminal offset.
- Channel arrays must match the current vertex or edge count.

See the repository docs for topology, channel, projection, and lifecycle guidance.
