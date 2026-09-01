# Create a network view

This tutorial creates a small WebGPU network renderer, loads a topology, binds a scalar channel, and fades the canvas in after the first frame.

## Create a canvas

The application owns the canvas. Give it a stable display size before creating the renderer:

```html
<canvas id="network" style="display: block; width: 100%; height: 480px"></canvas>
```

## Build a topology

`Topology` uses dense typed arrays. `vertexCoords` stores two numbers per vertex. `edges` stores endpoint pairs. `polylineStart` stores one offset per edge plus a terminal offset.

```ts
import { colormap } from '@latkit/colormaps';
import { requestDevice } from '@latkit/gpu';
import { createNetwork, type Topology } from '@latkit/network';

const canvas = document.getElementById('network');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Missing #network canvas.');
}

const topology: Topology = {
  vertexCount: 3,
  vertexCoords: new Float32Array([-96, 30, -95, 31, -94, 30]),
  coordinateSpace: 'geographic',
  edges: new Uint32Array([0, 1, 1, 2]),
  polylineStart: new Uint32Array([0, 0, 0]),
};

const device = await requestDevice();
const network = await createNetwork(device, canvas, {
  colormap: colormap('viridis'),
  graticule: true,
});

network.load(topology);
network.setChannel('vertexColor', new Float32Array([0.1, 0.8, 0.4]), [0, 1]);
network.fadeIn();
```

The view starts in the flat projection. After `load()`, `network.geographic` reports whether
caller-supplied coordinates are interpreted as longitude and latitude. Generated layouts are never
geographic, and `coordinateSpace: 'cartesian'` disables geographic inference. When geographic
coordinates also satisfy the required span and scale, `network.projections.globe` becomes true.

`flat` and `tilt` are two views of one planar camera. Projection changes animate
the same pitch state in either direction and reuse one WebGPU pipeline bundle.
A `vertexHeight` channel controls depth order at flat rest and blends
continuously into physical height as the view tilts.

Pan and rotation use the same CSS-pixel deltas as pointer gestures; zoom is
multiplicative:

```ts
network.panBy(24, 0);
network.zoomBy(1.2);

network.setProjection('tilt');
network.rotateBy(18, -8);

const pose = network.getPose();
if (pose) {
  network.setPose({ bearing: pose.bearing + 30 }, { animate: true });
}
```

`rotateBy()` changes bearing and pitch in `tilt` and `globe`; it is a no-op in
`flat`. `getPose()` returns the pose the next `setPose()` call builds on. Pose
updates merge partial center, pitch, and bearing fields and optionally animate. Read
`network.projection` for the active mode.

## Add interaction handlers

Use events to mirror hover and selection state into your app:

```ts
const unsubscribeHover = network.on('hover', (kind, index) => {
  console.log(kind, index);
});

// The host opts into keyboard context activation on the borrowed canvas.
canvas.tabIndex = 0;
const unsubscribeContext = network.on('contextmenu', (event) => {
  const items = network.hitTest(event.clientX, event.clientY);
  console.log(items);
});

if (network.projections.globe) {
  network.setProjection('globe');
}

network.setOptions({ edges: true, vertices: true, daylight: true });

unsubscribeHover();
unsubscribeContext();
```

A stationary secondary click emits `contextmenu`; crossing the normal mouse-drag threshold rotates instead. `hitTest` is synchronous, does not change hover or selection, and returns at most the best vertex followed by the best edge. `locate(item)` returns a client-space anchor for menus and DOM overlays without changing focus, including when the item is off-canvas or occluded.

Fit selected topology identities without changing selection:

```ts
network.fit([{ kind: 'vertex', index: 0 }], true);
```

Subset fitting includes edge bend points, ignores stale identities and display visibility, and preserves the whole-topology fit as the camera's zoom reference.

Use `reveal()` when an item should become visible without changing camera zoom:

```ts
network.reveal({ kind: 'vertex', index: 0 }, { paddingPx: 48, animate: true });
```

An item already visible inside the padded viewport is left in place. Pass
`{ center: true }` to center it explicitly. Reveal preserves scale, globe
distance, tilt, and bearing.

When your app removes the view, destroy the renderer before removing its canvas, and release the application-owned device last:

```ts
network.destroy();
canvas.remove();
device.destroy();
```

## Run the full example

The repository example adds topology switching, projection controls, an opt-in
camera animation, colormap controls, layer toggles, and picking:

```sh
pnpm --filter @latkit/network-example dev
```

Open `http://127.0.0.1:5188`.
