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
import { createNetwork, type Topology } from '@latkit/network';

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
network.setChannel('vertexColor', new Float32Array([0.1, 0.8, 0.4]), [0, 1]);
network.fadeIn();
```

`createNetwork()` accepts a native Core `GPUDevice` and a caller-owned
`HTMLCanvasElement`; `@latkit/gpu` is a convenient way to acquire the device
but is not required. The caller controls the canvas's placement and CSS size.

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
