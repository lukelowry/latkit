# API reference

The API reference is generated from the published package entrypoints with TypeDoc. Start with the package page that matches the renderer or helper you are using.

| Package                                             | Public surface                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`@latkit/network`](reference/network/index.md)     | Network renderer, topology input, channels, events, and display options        |
| [`@latkit/monitor`](reference/monitor/index.md)     | Monitor renderer, packed series input, readings, events, and display options   |
| [`@latkit/gpu`](reference/gpu/index.md)             | Core WebGPU device acquisition, availability failures, and canvas presentation |
| [`@latkit/colormaps`](reference/colormaps/index.md) | Colormap names, labels, transfer functions, and CSS gradients                  |
| [`@latkit/model`](reference/model/index.md)         | Columnar network model, packed series, run updates, grid queries, and sources  |

## Common entrypoints

- [`createNetwork`](reference/network/index.md#createnetwork) creates a network canvas controller.
- [`Topology`](reference/network/index.md) describes CPU-side graph data in the network package reference.
- [`createMonitor`](reference/monitor/index.md#createmonitor) creates a monitor canvas controller.
- [`Series`](reference/monitor/index.md) describes packed monitor samples in the monitor package reference.
- [`requestDevice`](reference/gpu/index.md#requestdevice) requests a native Core WebGPU device.
- [`createPresentation`](reference/gpu/index.md#createpresentation) configures a caller-owned canvas.
- [`colormap`](reference/colormaps/index.md#colormap) returns a normalized color transfer function.

```{toctree}
:maxdepth: 2
:hidden:
:glob:

reference/index
reference/**/*
```
