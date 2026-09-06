# Create a network view

This tutorial creates a small WebGPU network renderer, loads a topology, binds a scalar channel, and wires interaction.

## Create a canvas

The application owns the canvas. Give it a stable display size before attaching the controller:

```html
<canvas id="network" style="display: block; width: 100%; height: 480px"></canvas>
```

## Build a topology

`Topology` uses dense typed arrays. `vertexCoords` stores two numbers per vertex. `edges` stores endpoint pairs. `polylineStart` stores one offset per edge plus a terminal offset.

```ts
import { colormap } from '@latkit/colormaps';
import type { Topology } from '@latkit/model';
import { createNetwork } from '@latkit/network';

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

const network = createNetwork({
  colormap: colormap('viridis'),
  graticule: true,
});

network.load(topology);
network.setChannel('vertexColor', new Float32Array([0.1, 0.8, 0.4]), [0, 1]);

await network.attach(canvas);
```

`createNetwork()` takes neither a device nor a canvas; `attach()` leases a device from the shared pool and paints what the controller holds. See [Lifecycle and failures](lifecycle.md).

The view starts in the flat projection. After `load()`, `network.geographic` reports whether caller-supplied coordinates are interpreted as longitude and latitude, and `network.projections.globe` reports whether they satisfy the globe's span and scale. Loading a topology that is already loaded is a no-op, and `load(topology, { fit: false })` keeps a placed camera.

`flat` and `tilt` are two views of one planar camera. A `vertexHeight` channel controls depth order at flat rest and blends continuously into physical height as the view tilts.

Pan and rotation use the same CSS-pixel deltas as pointer gestures; zoom is multiplicative:

```ts
network.panBy(24, 0);
network.zoomBy(1.2);

network.setProjection('tilt');
network.rotateBy(18, -8);

const pose = network.getPose();
if (pose) {
  network.setPose({ bearing: pose.bearing + 30 }, true);
}
```

`rotateBy()` changes bearing and pitch in `tilt` and `globe`; it is a no-op in `flat`. `getPose()` returns the pose the next `setPose()` call builds on. Read `network.projection` for the active mode, and pass `setProjection(mode, true)` to fall back to the first projection the loaded topology can host. `orbit(true)` starts continuous rotation until a gesture or `orbit(false)` stops it.

## Keyboard, motion, and wheel

The controller owns the input policy. The `keyboard` option attaches the key map to the canvas, `motion` follows `prefers-reduced-motion` by default, and `wheel: 'modifier'` leaves a plain wheel to the page:

```ts
network.setOptions({ keyboard: true, motion: 'auto', wheel: 'modifier' });
```

## Add interaction handlers

Every event carries one payload. Use them to mirror hover and selection state into your app:

```ts
const unsubscribeHover = network.on('hover', (item) => {
  console.log(item?.kind, item?.index);
});

const unsubscribeContext = network.on('contextmenu', ({ clientX, clientY, items, keyboard }) => {
  openMenu(clientX, clientY, items, keyboard);
});

if (network.projections.globe) {
  network.setProjection('globe');
}

network.setOptions({ edges: true, vertices: true, daylight: true });

unsubscribeHover();
unsubscribeContext();
```

`contextmenu` arrives with the anchor and the items already resolved, from the pointer or from the Menu key and Shift+F10. `hitTest` is synchronous, does not change hover or selection, and returns at most the best vertex followed by the best edge. `locate(item)` returns a client-space anchor for menus and DOM overlays without changing focus. `neighborhood(item)` lists an item with what touches it.

Fit selected topology identities without changing selection:

```ts
network.fit([{ kind: 'vertex', index: 0 }], true);
```

Use `reveal()` when an item should become visible without changing camera zoom:

```ts
network.reveal({ kind: 'vertex', index: 0 }, { animate: true });
network.reveal({ kind: 'vertex', index: 0 }, { neighbors: true, animate: true });
```

An item already inside the `revealPaddingPx` inset is left in place; `{ neighbors: true }` frames it with its neighborhood instead.

When your app removes the view, destroy the controller before removing its canvas:

```ts
network.destroy();
canvas.remove();
```

## Run the full example

The repository example adds topology switching, projection controls, an opt-in camera animation, colormap controls, layer toggles, and picking:

```sh
pnpm --filter @latkit/network-example dev
```

Open `http://127.0.0.1:5188`.
