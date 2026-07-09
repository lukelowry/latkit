# Getting started

Install the packages you need from npm:

```sh
npm install @latkit/model @latkit/colormaps @latkit/monitor @latkit/network
```

Latkit is published as ESM and targets modern runtimes. The rendering packages expect browser support for WebGPU.

## Packages

`@latkit/model`
: Shared model primitives for the package family.

`@latkit/colormaps`
: Named colormap data and helpers for gradients and scale metadata.

`@latkit/monitor`
: A WebGPU signal monitor for time-oriented readings.

`@latkit/network`
: A WebGPU renderer for interactive network topology views.

## Import pattern

Use package entrypoints directly:

```ts
import { colormap } from '@latkit/colormaps';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
```

The API reference is generated from those public entrypoints, so internal modules remain free to move.
