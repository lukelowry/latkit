<p align="center">
  <img src="docs/_static/banner.png" alt="Latkit visualization banner" width="100%">
</p>

# Latkit

[![CI](https://github.com/lukelowry/latkit/actions/workflows/ci.yml/badge.svg)](https://github.com/lukelowry/latkit/actions/workflows/ci.yml)
[![Documentation Status](https://readthedocs.org/projects/latkit/badge/?version=latest)](https://latkit.readthedocs.io/en/latest/)

TypeScript tools for WebGPU network views, time-series plots, block diagrams, and video export.

[Documentation](https://latkit.readthedocs.io/en/latest/) · [API reference](https://latkit.readthedocs.io/en/latest/api/index.html) · [Examples](examples)

## Install

```sh
npm install @latkit/model @latkit/gpu @latkit/network
```

Use an ESM bundler and a WebGPU-capable browser.

## Draw a network

```ts
import { createGpu } from '@latkit/gpu';
import { createNetwork } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork(gpu, {
  canvas,
  source,
  vertices: { Bus: { color: 'load', labels: 'name' } },
  edges: { Line: { ends: ['from', 'to'] } },
});
network.on('select', (items) => console.log(items));
network.set({ at: 12 });

network.destroy(); // never closes the source or the GPU
```

`source` is a `Data` from [`@latkit/model`](packages/model). `canvas` needs a CSS size; the network
draws on it and handles its input. Monitors and diagrams work the same way; see
[views](https://latkit.readthedocs.io/en/latest/views.html).

## Packages

| Package                     | Use                                                |
| --------------------------- | -------------------------------------------------- |
| [model](packages/model)     | Columnar data, bounded reads, the `Model` contract |
| [connect](packages/connect) | Carry a model across a WebSocket                   |
| [gpu](packages/gpu)         | The shared GPU, compositions, and colors           |
| [network](packages/network) | Vertices, edges, and paths, flat or on a globe     |
| [monitor](packages/monitor) | Time-series plots and live telemetry               |
| [diagram](packages/diagram) | Block diagrams with layout, routing, and editing   |
| [video](packages/video)     | MP4 and WebM export                                |

## Develop

Requires Node.js 24 and pnpm 10.30.

```sh
pnpm install
pnpm --filter @latkit/network-example dev
pnpm quality
pnpm build:examples
pnpm docs:build
```

See [release checks](docs/release-process.md) for browser tests and packaging.

Created by [Luke Lowery](https://lukelowry.github.io/). [MIT License](LICENSE).
