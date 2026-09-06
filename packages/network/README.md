# @latkit/network

WebGPU network renderer for Latkit: one controller, `Network`, and three registries that name what
it speaks, `CHANNELS`, `OPTIONS`, and `PROJECTIONS`.

## Install

```sh
npm install @latkit/network @latkit/model @latkit/colormaps
```

## Basic use

```ts
import { colormap } from '@latkit/colormaps';
import type { Topology } from '@latkit/model';
import { createNetwork } from '@latkit/network';

const topology: Topology = {
  vertexCount: 3,
  vertexCoords: new Float32Array([-96, 30, -95, 31, -94, 30]),
  coordinateSpace: 'geographic',
  edges: new Uint32Array([0, 1, 1, 2]),
  polylineStart: new Uint32Array([0, 0, 0]),
};

const network = createNetwork({ colormap: colormap('viridis'), graticule: true });
network.load(topology);
network.setChannel('vertexColor', new Float32Array([0.1, 0.8, 0.4]), [0, 1]);

const canvas = document.querySelector<HTMLCanvasElement>('#network')!;
await network.attach(canvas);
```

The controller holds everything it is given; `attach` leases a shared device and paints it, and
`detach` keeps it for the next canvas. See the [lifecycle guide](https://latkit.readthedocs.io/en/latest/lifecycle.html).

`Topology` and `Item` are `@latkit/model`'s: a model's topology loads unchanged, and the item a
pick returns is the item `elementAt` resolves. Loading the topology already loaded is a no-op;
`load(topology, { fit: false })` keeps a placed camera.

## Channels

`setChannel` binds, replaces, or clears (`null`) one per-vertex or per-edge stream. Normalized
channels take an input domain; `null` scans the finite extent of a height channel and defaults the
rest to `[0, 1]`. `setChannelDomain` moves the domain without re-uploading, and `getChannelDomain`
reads the one in effect.

```ts
network.setChannel('vertexColor', values, [0, 1]);
network.setChannel('vertexHeight', lift, null);
network.setChannelDomain('vertexColor', [0.2, 0.8]);
network.setChannel('vertexHeight', null);
```

`vertexHeight` orders overlapping geometry by depth in `flat` and becomes physical lift as the
camera tilts; the `heightRange` option is the output range it maps onto. `vertexVisible` and
`edgeVisible` are raw masks: values greater than zero are visible. `edgeDash` is raw too. Every
channel slot is allocated when a topology loads, so rebinding never reallocates GPU storage.

## Options

Every display option is a live patch through `setOptions`; only `msaa` and `devices` are fixed at
construction. `OPTIONS` carries each option's default, validation kind, and whether it is live, and
`validateOptions` checks a patch before a device exists.

```ts
network.setOptions({
  colormap: colormap('magma'),
  vertexBaseColor: [0.5, 0.5, 0.5, 1],
  edgeBaseColor: null, // average the endpoint colors
  vertexScale: 1.25,
  edgeScale: 0.8,
  heightRange: [0, 0.8],
  sizeRange: [0.5, 2],
  sunTime: null, // follow the clock, or pin an instant in ms since the epoch
  animationMs: 500,
  orbitRate: 1,
  revealPaddingPx: 48,
  pickRadiusPx: 10,
  keyboard: true,
  motion: 'auto',
  wheel: 'modifier',
});
```

A nullable option takes `null` to hand the decision back to the controller. The reference
documents each option.

## Selection and navigation

`select` changes only the focus ring and takes `null` to clear; `reveal` brings an item into view
without changing zoom or projection, and with `neighbors` frames it with what touches it; subset
`fit` deliberately reframes.

```ts
const item = { kind: 'vertex', index: 1 } as const;

network.select(item);
network.reveal(item, { animate: true });
network.reveal(item, { neighbors: true, animate: true });
network.fit(network.neighborhood(item), true);
network.select(null);
```

Navigation takes CSS-pixel deltas and multiplicative zoom:

```ts
network.panBy(24, 0);
network.zoomBy(1.2);

network.setProjection('tilt');
network.rotateBy(18, -8);

const pose = network.getPose();
if (pose) network.setPose({ bearing: pose.bearing + 30 }, true);
```

`network.projection` reports the active mode, `setProjection(mode, true)` falls back through
`PROJECTIONS` to the first mode the loaded topology can host, and `orbit(true)` starts continuous
rotation until a gesture or `orbit(false)` stops it.

## Events

Every event carries one payload:

```ts
network.on('hover', (item) => console.log(item?.kind, item?.index));
network.on('select', (item) => (item ? inspect(item) : close()));
network.on('contextmenu', ({ clientX, clientY, items }) => menu.open(clientX, clientY, items));
network.on('fit', (atFitView) => (button.disabled = atFitView));
network.on('orbit', (active) => (button.pressed = active));
network.on('attached', (attached) => (canvas.hidden = !attached));
network.on('deviceLost', ({ message, recovering }) => !recovering && showFallback(message));
network.on('pipelineError', ({ family, cause }) => console.error(family, cause));
```

## Packaged borders

`@latkit/network/borders` loads the Natural Earth 50m line borders as a `Borders` payload from the
assets this package publishes under `@latkit/network/assets/*`. One request is shared by every
caller in a module instance.

```ts
import { loadBorders } from '@latkit/network/borders';

network.setBorders(await loadBorders(signal));
```

## Registries

`CHANNELS`, `OPTIONS`, and `PROJECTIONS` are frozen and ordered. A picker iterates
`Object.keys(CHANNELS)` and shows `CHANNELS[key].label`; a settings form iterates `OPTIONS` and
reads each entry's `default`, `kind`, and `live`; a projection control iterates `PROJECTIONS` and
checks `network.projections[mode]`.

## Data shape

- `vertexCoords` stores two numbers per vertex. Omit it to use a generated ring layout.
- `coordinateSpace` declares explicit coordinates as `'cartesian'` or `'geographic'`.
- `edges` stores endpoint pairs.
- `polylineStart` stores one offset per edge plus a terminal offset.
- Channel arrays must match the current vertex or edge count.

`network.geographic` reports how the loaded coordinates are interpreted: explicit coordinates
inside longitude and latitude bounds are geographic unless `coordinateSpace: 'cartesian'` opts out,
and generated layouts never are. `network.projections.globe` additionally reflects the required
geographic span and scale. `validateTopology` from `@latkit/model` checks a topology before a
device exists.

See the repository docs for topology, channel, projection, and lifecycle guidance.
