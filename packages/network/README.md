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
`edgeVisible` are raw masks: values greater than zero are visible. `edgeDash` is raw too, and so
are `vertexShade` and `edgeShade`, which carry one scalar per item to a shade (below). Every
channel slot is allocated when a topology loads, so rebinding never reallocates GPU storage.

`vertexPosition` is where every vertex sits, as interleaved `x, y` pairs in topology coordinates,
the shape `vertexCoords` has. `load` seeds it from the topology, and rebinding it moves vertices,
the ends of their edges, and their height poles without reloading anything; `null` restores the
topology's own layout. A layout engine writes one array per frame and hands it over:

```ts
network.setChannel('vertexPosition', simulation.positions);
network.fit(true); // frames the positions in effect
network.setChannel('vertexPosition', null);
```

Polyline bends stay where the topology put them, and vertex radius, the geographic
interpretation, and longitude wrapping stay the topology's. The globe draws the layout the
topology carries, so `projections.globe` is false while positions override it; binding one on the
globe falls back to flat. While positions change from one frame to the next, hover clears and
picks find nothing, and they resume one frame after the last write; `locate` is always live.

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
  interaction: 'inspect',
  fitPaddingPx: [96, 32, 160, 32],
  fitPitch: 50,
  fitBearing: -18,
});
```

A nullable option takes `null` to hand the decision back to the controller. The reference
documents each option.

`fitPaddingPx`, `fitPitch`, and `fitBearing` define the fit itself: the inset every fit keeps
clear, in CSS pixels as one value or `[top, right, bottom, left]`, and the orientation it rests at
in `tilt` and `globe`. Because the controller refits on every resize while the camera is at fit,
a framed view stays framed with no work in the host.

`interaction` says what input does. `'navigate'` moves the camera. `'inspect'` keeps hover, tap
selection with cycling through overlapping items, and keyboard stepping, while wheel and touch
scrolling stay the page's. `'none'` installs no listeners at all.

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

Under `interaction: 'inspect'` the arrow keys walk the selection along the topology: a vertex
steps to the far end of the edge lying most in that direction, an edge steps to one of its
endpoints, and with nothing selected the walk starts from the item nearest the center.

A canvas that receives no pointer events itself, such as a backdrop under page content, reports
the pointer with `setPointer`. It drives hover picking, `hover` events, and the shade's pointer
exactly as the canvas's own pointer does:

```ts
document.addEventListener('pointermove', (e) => network.setPointer(e.clientX, e.clientY));
document.addEventListener('pointerleave', () => network.setPointer(null));
```

## Shades

A shade is a fragment hook: WGSL declaring `fn shade(f: Fragment) -> vec4f`, compiled into the
vertex and edge passes, plus an optional `tick` that writes a 64-float `host` block before each
frame. That is the whole cost of an effect on any graph: one small uniform upload per frame and
nothing per item. `setShade` resolves once the active projection draws with the shade and
rejects, keeping the previous one, when the WGSL fails to compile.

```ts
await network.setShade({
  wgsl: `
    fn shade(f: Fragment) -> vec4f {
      let d = distance(f.px, u.pointer_px);
      let lit = smoothstep(240.0, 0.0, d) * (0.4 + 0.6 * f.value);
      return vec4f(mix(f.color.rgb, vec3f(1.0, 0.8, 0.5), lit), f.color.a);
    }`,
});
```

`Fragment` carries the color the pass would paint, the fragment's canvas-local CSS pixel and
projection world position, the item's kind, index, and focus state, and its `vertexShade` or
`edgeShade` channel value. `u.pointer_px` is the latest pointer in the same pixel space. A `tick`
receives the frame's time, pointer, and viewport, and returns true to keep frames coming:

```ts
await network.setShade({
  wgsl: 'fn shade(f: Fragment) -> vec4f { return mix(f.color, host[0], host[1].x); }',
  tick(host, { timeMs }) {
    host.set([1, 1, 1, 1, 0.5 + 0.5 * Math.sin(timeMs / 400)]);
    return true;
  },
});
await network.setShade(null);
```

`@latkit/network/shades` ships presets built on the same hook. `spotlight` is a soft light that
follows the pointer and fades once it leaves:

```ts
import { spotlight } from '@latkit/network/shades';

await network.setShade(spotlight({ radiusPx: 220, strength: 0.6, color: [1, 0.72, 0.3, 1] }));
```

## Events

Every event carries one payload:

```ts
network.on('hover', (item) => console.log(item?.kind, item?.index));
network.on('select', (item) => (item ? inspect(item) : close()));
network.on('contextmenu', ({ clientX, clientY, items }) => menu.open(clientX, clientY, items));
network.on('fit', (atFitView) => (button.disabled = atFitView));
network.on('orbit', (active) => (button.pressed = active));
network.on('attached', (attached) => (canvas.hidden = !attached));
network.on('painted', (painted) => (poster.hidden = painted));
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
