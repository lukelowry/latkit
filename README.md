<p align="center">
  <img src="docs/_static/banner.png" alt="Latkit visualization banner" width="100%">
</p>

# Latkit

[![CI](https://github.com/lukelowry/latkit/actions/workflows/ci.yml/badge.svg)](https://github.com/lukelowry/latkit/actions/workflows/ci.yml)
[![Documentation Status](https://readthedocs.org/projects/latkit/badge/?version=latest)](https://latkit.readthedocs.io/en/latest/?badge=latest)

Latkit is a TypeScript package family for interactive, browser-based WebGPU visualization of network topology, block diagrams, and time-series data.

[Documentation](https://latkit.readthedocs.io/en/latest/) &middot; [Getting started](https://latkit.readthedocs.io/en/latest/getting-started.html) &middot; [API reference](https://latkit.readthedocs.io/en/latest/api/index.html) &middot; [Examples](./examples)

## Packages

Install only the packages your application needs.

| Package                                                            | Description                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [`@latkit/network`](https://www.npmjs.com/package/@latkit/network) | Interactive WebGPU network topology views                           |
| [`@latkit/monitor`](https://www.npmjs.com/package/@latkit/monitor) | WebGPU time-series and signal monitor views                         |
| [`@latkit/diagram`](https://www.npmjs.com/package/@latkit/diagram) | WebGPU block diagrams with automatic layout and edit proposals      |
| [`@latkit/embed`](https://www.npmjs.com/package/@latkit/embed)     | `latkit-network` and `latkit-monitor` custom elements               |
| [`@latkit/gpu`](https://www.npmjs.com/package/@latkit/gpu)         | Shared WebGPU resources, fields, text, colors, and frame submission |
| [`@latkit/model`](https://www.npmjs.com/package/@latkit/model)     | Native model, document, recording, and query contracts              |
| [`@latkit/connect`](./packages/connect)                            | Transport for native model services and acquisitions                |
| [`@latkit/video`](./packages/video)                                | Worker-based video export of network, diagram, and monitor scenes   |

## Requirements

- A WebGPU-capable browser for `@latkit/network`, `@latkit/monitor`, and `@latkit/diagram`
- An ESM-capable bundler or development server
- Node.js 24 when developing Latkit locally

## Current migration

`model`, `connect`, `gpu`, and `network` use the new contracts. `monitor`, `diagram`, `embed`, and `video` still need migration. The old `port` and `colormaps` packages have been deleted; there are no compatibility exports. Colors and colormaps now come from `@latkit/gpu`.

## Network usage

Given an acquired document with a `node` type containing `position` and `load` fields, and a `line` type exposing pair endpoints:

```ts
import { createGpu, createCanvasView, colormaps } from '@latkit/gpu';
import { createNetwork, attachNetworkInput } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork({
  gpu,
  data: {
    source: document,
    coordinates: 'geographic',
    vertices: {
      node: {
        position: 'position',
        color: { field: 'load', domain: [0, 1], colormap: colormaps.viridis },
      },
    },
    edges: { line: { connectivity: { kind: 'endpoints', layout: 'pair' } } },
  },
});
const view = createCanvasView({ gpu, canvas, renderer: network, onError: console.error });
const detach = attachNetworkInput({ network, canvas });
view.request();

// When the application closes the view:
detach();
view.destroy();
network.destroy();
gpu.destroy();
// The application separately releases its borrowed document acquisition.
```

See [network usage](packages/network/README.md), [shared GPU preparation](packages/gpu/README.md), and [colors and colormaps](docs/colormaps.md) for the current APIs.

## Examples

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

Open `http://127.0.0.1:5188/` for the network demo and `/colors.html` for the color catalog. The gallery compares all 46 maps in CPU, CSS, and WebGPU. Other package examples await migration.

## Documentation

The full guides and generated TypeScript API reference are published on [Read the Docs](https://latkit.readthedocs.io/en/latest/). Documentation sources live in [`docs/`](./docs) and use MyST Markdown with Sphinx.

Build the documentation locally with:

```sh
pnpm docs:build
```

## Development

```sh
pnpm install
pnpm quality
```

The `quality` command checks formatting, linting, types, and tests across the workspace. See the [release process](https://latkit.readthedocs.io/en/latest/release-process.html) for package publishing details.

## Related work

Selected related projects include:

- [`sgwt`](https://pypi.org/project/sgwt/)
- [`esapp`](https://pypi.org/project/esapp/)
- [`ORNL/GridKit`](https://github.com/ORNL/GridKit)

## Author

Latkit is developed by [Luke Lowery](https://lukelowry.github.io/) and began during his PhD studies at Texas A&M University. See his [Google Scholar profile](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en) for publications and the [author page](https://latkit.readthedocs.io/en/latest/about-author.html) for more information.

## License

Latkit packages are released under the [MIT License](./LICENSE).
