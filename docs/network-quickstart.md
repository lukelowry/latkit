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

The view starts in the flat projection. If the topology coordinates fit the geographic range required for globe mode, `network.projections.globe` becomes true after `load()`.

## Add interaction handlers

Use events to mirror hover and selection state into your app:

```ts
const unsubscribeHover = network.on('hover', (kind, index) => {
  console.log(kind, index);
});

if (network.projections.globe) {
  network.setProjection('globe');
}

network.setOptions({ edges: true, vertices: true, daylight: true });

unsubscribeHover();
```

When your app removes the view, destroy the renderer before removing its canvas, and release the application-owned device last:

```ts
network.destroy();
canvas.remove();
device.destroy();
```

## Run the full example

The repository example adds topology switching, projection controls, colormap controls, layer toggles, and picking:

```sh
pnpm --filter @latkit/network-example dev
```

Open `http://127.0.0.1:5188`.
