# API reference

The API reference is generated from the published package entrypoints with TypeDoc. Start with the package page that matches the renderer or helper you are using.

| Package                                             | Public surface                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@latkit/network`](reference/network/index.md)     | Network renderer, topology input, channels, events, and display options      |
| [`@latkit/monitor`](reference/monitor/index.md)     | Monitor renderer, packed series input, readings, events, and display options |
| [`@latkit/colormaps`](reference/colormaps/index.md) | Colormap names, labels, transfer functions, and CSS gradients                |
| [`@latkit/model`](reference/model/index.md)         | Shared model primitives as they become public                                |

## Common entrypoints

- [`createNetwork`](reference/network/index.md#createnetwork) creates a network canvas controller.
- [`Topology`](reference/network/index/interfaces/Topology.md) describes CPU-side graph data.
- [`createMonitor`](reference/monitor/index.md#createmonitor) creates a monitor canvas controller.
- [`Series`](reference/monitor/index/interfaces/Series.md) describes packed monitor samples.
- [`colormap`](reference/colormaps/index.md#colormap) returns a normalized color transfer function.

```{toctree}
:maxdepth: 2
:hidden:
:glob:

reference/index
reference/*/index
reference/*/index/interfaces/*
```
