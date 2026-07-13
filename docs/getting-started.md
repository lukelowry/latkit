# Getting started

This guide gets a local Latkit checkout or downstream app to its first rendered view.

## Prerequisites

- Node.js 22 or newer.
- A browser with WebGPU support.
- A bundler or dev server that can load ESM packages.

## Install packages

Install only the packages your app needs:

```sh
npm install @latkit/model @latkit/colormaps @latkit/gpu @latkit/monitor @latkit/network
```

Most applications start with one renderer plus colormaps:

```sh
npm install @latkit/network @latkit/colormaps
```

or:

```sh
npm install @latkit/monitor @latkit/colormaps
```

## Choose a package

`@latkit/model`
: Shared model primitives for the package family.

`@latkit/colormaps`
: Named colormap data and helpers for gradients and scale metadata.

`@latkit/gpu`
: Shared Core WebGPU device acquisition for renderers in one browser realm.

`@latkit/monitor`
: A WebGPU signal monitor for time-oriented readings.

`@latkit/network`
: A WebGPU renderer for interactive network topology views.

## Use public entrypoints

Use package entrypoints directly:

```ts
import { colormap } from '@latkit/colormaps';
import { createGpu } from '@latkit/gpu';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
```

The API reference is generated from those entrypoints, so internal source modules remain free to move.

## Run the examples

The repository includes Vite examples that consume the same package entrypoints downstream apps use.

Run the network example:

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

Open `http://127.0.0.1:5188` in a WebGPU-capable browser.

Run the monitor example:

```sh
pnpm install
pnpm --filter @latkit/monitor-example dev
```

Open `http://127.0.0.1:5190`.

## Next steps

- Use [Create a network view](network-quickstart.md) to render a small topology.
- Use [Create a monitor](monitor-quickstart.md) to render packed signal data.
- Use [Topology and channels](topology-and-channels.md) when adapting real data.
