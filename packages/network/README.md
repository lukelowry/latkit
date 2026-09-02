# @latkit/network

WebGPU network renderer for Latkit: one controller, `Network`, and three registries that name what
it speaks, `CHANNELS`, `OPTIONS`, and `PROJECTIONS`.

## Install

```sh
npm install @latkit/gpu @latkit/network @latkit/colormaps
```

## Basic use

```ts
import { colormap } from '@latkit/colormaps';
import { requestDevice } from '@latkit/gpu';
import { createNetwork, type Topology } from '@latkit/network';

const topology: Topology = {
  vertexCount: 3,
  vertexCoords: new Float32Array([-96, 30, -95, 31, -94, 30]),
  coordinateSpace: 'geographic',
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
network.setChannel('vertexColor', new Float32Array([0.1, 0.8, 0.4]), [0, 1]);
```

`Topology` and `Item` are `@latkit/model`'s: a model's topology loads unchanged, and the item a
pick returns is the item `elementAt` resolves.

## Channels

`setChannel` binds, replaces, or clears (`null`) one per-vertex or per-edge stream. Normalized
channels take an input domain; `null` scans the finite extent of a height channel and defaults the
rest to `[0, 1]`. `setChannelDomain` moves the domain without re-uploading, and `getChannelDomain`
reads the one in effect, so a legend never recomputes it.

```ts
network.setChannel('vertexColor', values, [0, 1]);
network.setChannel('vertexHeight', lift, null);
network.setChannelDomain('vertexColor', [0.2, 0.8]);
network.setChannel('vertexHeight', null);
```

`vertexHeight` orders overlapping geometry by depth in `flat`, then becomes physical lift
continuously as the same planar camera tilts; the `heightRange` option is the output range it maps
onto. `vertexVisible` and `edgeVisible` are raw masks: values greater than zero are visible, while
zero, negative values, and `NaN` are hidden. `edgeDash` is raw too.

## Options

Every display option is a live patch through `setOptions`; only `msaa` is fixed at construction.
`OPTIONS` carries each option's default, validation kind, and whether it is live, and
`validateOptions` checks a patch before a device exists.

```ts
network.setOptions({
  colormap: colormap('magma'),
  baseColor: [0.5, 0.5, 0.5, 1],
  vertexScale: 1.25, // vertex radius
  edgeScale: 0.8, // edge half-width
  heightScale: 1.5, // vertex-height displacement
  heightRange: [0, 0.8],
  dashPeriodPx: 12, // CSS-pixel edge-dash period; 0 renders solid
});
```

## Selection and navigation

`Item` is the renderer's stable vertex/edge identity. `select` changes only the focus ring and
takes `null` to clear; `reveal` brings an item into view without changing zoom or projection, and
with `neighbors` frames it with what touches it; subset `fit` deliberately reframes.

```ts
const item = { kind: 'vertex', index: 1 } as const;

network.select(item);
network.reveal(item, { paddingPx: 48, animate: true });
network.reveal(item, { neighbors: true, animate: true });
network.fit(network.neighborhood(item), true);
network.select(null);
```

An item already visible inside the reveal padding is left in place. Pass `{ center: true }` for an
explicit centering command. Reveal retains scale, globe distance, tilt, and bearing; a newer camera
command replaces any in-progress move.

Navigation methods use relative screen-space input. Deltas are CSS pixels and zoom is
multiplicative:

```ts
network.panBy(24, 0);
network.zoomBy(1.2);

network.setProjection('tilt');
network.rotateBy(18, -8);

const pose = network.getPose();
if (pose) network.setPose({ bearing: pose.bearing + 30 }, true);
```

Rotation changes bearing and pitch in `tilt` and `globe`; `flat` has no rotational freedom.
`getPose()` returns the camera pose that the next `setPose()` call builds on. `network.projection`
reports the active mode, and `setProjection(mode, true)` falls back through `PROJECTIONS` to the
first mode the loaded topology can host.

`orbit(true)` starts continuous rotation: a flat view promotes to tilt, a planar view drags, and a
globe drifts longitude. A pointer or wheel gesture stops it, `network.orbiting` reports the state,
and the `orbit` event reports every transition. The host keeps its own reduced-motion gate.

## Events

Every event carries one payload:

```ts
network.on('hover', (item) => console.log(item?.kind, item?.index));
network.on('select', (item) => (item ? inspect(item) : close()));
network.on('zoom', (atFitView) => (button.disabled = atFitView));
network.on('orbit', (active) => (button.pressed = active));
network.on('deviceLost', ({ reason, message }) => console.error(reason, message));
network.on('pipelineError', ({ family, cause }) => console.error(family, cause));
```

## Packaged borders

`@latkit/network/borders` loads the Natural Earth 50m line borders (coastlines, land boundaries,
and state or province lines) as a `Borders` payload, from the assets this package publishes under
`@latkit/network/assets/*`. One request is shared by every caller in a module instance; a
rejection is never memoized, and a caller's `signal` ends only that caller's wait.

```ts
import { loadBorders } from '@latkit/network/borders';

network.setBorders(await loadBorders(signal));
```

## Registries

`CHANNELS`, `OPTIONS`, and `PROJECTIONS` are frozen and ordered. A picker iterates
`Object.keys(CHANNELS)` and shows `CHANNELS[key].label`; a settings form iterates `OPTIONS` and
reads each entry's `default`, `kind`, and `live`; a projection control iterates `PROJECTIONS` and
checks `network.projections[mode]`.

## Lifecycle

`createNetwork()` accepts a native Core `GPUDevice` and a caller-owned `HTMLCanvasElement`.
`@latkit/gpu` acquires the device and supplies Network's shared presentation internals. The caller
controls the canvas's placement, CSS size, and visibility.

Network borrows both. Destroy the renderer before removing the canvas, and destroy the device only
after every renderer using it has been destroyed:

```ts
network.destroy();
canvas.remove();
device.destroy();
```

## Data shape

- `vertexCoords` stores two numbers per vertex. Omit it to use an abstract generated ring layout.
- `coordinateSpace` can declare explicit coordinates as `'cartesian'` or `'geographic'`.
- `edges` stores endpoint pairs.
- `polylineStart` stores one offset per edge plus a terminal offset.
- Channel arrays must match the current vertex or edge count.

`network.geographic` reports how the loaded coordinates are interpreted. Generated layouts are
never geographic. Explicit coordinates inside longitude and latitude bounds are inferred
geographic unless `coordinateSpace: 'cartesian'` opts out; `'geographic'` documents intent but
does not bypass those bounds. `network.projections.globe` additionally reflects the required
geographic span and scale. `validateTopology` checks a topology before a device exists.

See the repository docs for topology, channel, projection, and lifecycle guidance.
