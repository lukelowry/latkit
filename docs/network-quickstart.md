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

`interaction: 'inspect'` goes further: the camera never moves, wheel and touch scrolling stay the page's, and the canvas keeps hover, tap selection, and arrow keys that walk the selection along the topology. `'none'` installs no listeners. A canvas that receives no pointer events, such as a backdrop under page content, reports the pointer with `setPointer(clientX, clientY)` and releases it with `setPointer(null)`; hover picking and `hover` events follow it as they would the canvas's own pointer.

## Frame the fit

The fit is the view every resize, `fit()`, Home key, and double-tap returns to. Three options define it: `fitPaddingPx` is the inset it keeps clear, one value or `[top, right, bottom, left]` in CSS pixels, and `fitPitch` and `fitBearing` are the orientation it rests at in `tilt` and `globe`. While the camera is at fit, a resize refits inside the frame that renders the new size, so a page never needs to reframe the view itself:

```ts
network.setOptions({ fitPaddingPx: [96, 32, 160, 32], fitPitch: 50, fitBearing: -18 });
network.setProjection('tilt');
```

## Shade the fragments

A shade is a WGSL function compiled into the vertex and edge passes. It receives what the pass would paint plus where and what the fragment is, and returns the color to paint. A `tick` may write a 64-float `host` block before each frame, so an effect costs one small upload per frame regardless of graph size. The `vertexShade` and `edgeShade` channels carry one scalar per item into it as `f.value`.

```ts
import { spotlight } from '@latkit/network/shades';

await network.setShade(spotlight({ radiusPx: 220, strength: 0.6 }));

await network.setShade({
  wgsl: `
    fn shade(f: Fragment) -> vec4f {
      let d = distance(f.px, u.pointer_px);
      return vec4f(mix(f.color.rgb, vec3f(1.0), smoothstep(200.0, 0.0, d) * f.value), f.color.a);
    }`,
});
```

`setShade` resolves once the active projection draws with the shade; a shade that fails to compile rejects with the compiler's message and leaves the previous shade in place. The `painted` event and property report the first frame shown after each attach, which is the right moment to drop a poster.

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
