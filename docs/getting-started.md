# Getting started

This guide gets a local Latkit checkout or downstream app to its first rendered view.

## Prerequisites

- Node.js 24.
- A browser with WebGPU support.
- A bundler or dev server that can load ESM packages.

## Install packages

Install only the packages your app needs:

```sh
npm install @latkit/model @latkit/colormaps @latkit/gpu @latkit/monitor @latkit/network @latkit/diagram @latkit/embed @latkit/port @latkit/remote
```

Most applications start with one renderer plus colormaps:

```sh
npm install @latkit/network @latkit/colormaps
```

or:

```sh
npm install @latkit/monitor @latkit/colormaps
```

or, for block diagrams:

```sh
npm install @latkit/diagram @latkit/model @latkit/colormaps
```

A page that wants a tag instead of a controller installs `@latkit/embed`.

## Choose a package

`@latkit/model`
: The columnar model and the vocabulary every renderer speaks: `Topology`, `Netlist`, `Item`, `Series`, `Domain`.

`@latkit/port`
: A port over workers, webviews, and sockets, and typed request, reply, and stream protocols over it.

`@latkit/remote`
: A model's source, runner, and grids served across a port.

`@latkit/colormaps`
: Named colormap data and helpers for gradients and scale metadata.

`@latkit/gpu`
: Core WebGPU device acquisition, the device pool every renderer leases from, canvas presentation, and the frame loop every renderer schedules its frames with. Renderers depend on it; applications rarely import it.

`@latkit/monitor`
: A WebGPU signal monitor for time-oriented readings.

`@latkit/network`
: A WebGPU renderer for interactive network topology views.

`@latkit/diagram`
: A WebGPU block-diagram renderer and editor surface: automatic layout, right-angle wires, live values on blocks and wires, and edits reported as proposals. `@latkit/diagram/layout` computes the same layout without a device.

`@latkit/embed`
: `latkit-network` and `latkit-monitor`, the same controllers as custom elements.

## Use public entrypoints

Use package entrypoints directly:

```ts
import { colormap } from '@latkit/colormaps';
import { createDiagram } from '@latkit/diagram';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
```

The API reference is generated from those entrypoints, so internal source modules remain free to move.

## Run the examples

The repository includes Vite examples that consume the same package entrypoints downstream apps use. Install once, then run one in a WebGPU-capable browser:

```sh
pnpm install
pnpm --filter @latkit/network-example dev   # http://127.0.0.1:5188
pnpm --filter @latkit/monitor-example dev   # http://127.0.0.1:5190
pnpm --filter @latkit/embed-example dev     # http://127.0.0.1:5192
pnpm --filter @latkit/diagram-example dev   # http://127.0.0.1:5194
```

## Next steps

- Use [Create a network view](network-quickstart.md) to render a small topology.
- Use [Create a monitor](monitor-quickstart.md) to render packed signal data.
- Use [Create a block diagram](diagram-quickstart.md) to render and edit a netlist.
- Use [Topology and channels](topology-and-channels.md) when adapting real data.
- Use [Lifecycle and failures](lifecycle.md) to attach, detach, and recover.
