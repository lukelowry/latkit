# API reference

The API reference is generated from the published package entrypoints with TypeDoc. Start with the package page that matches the renderer or helper you are using.

| Package                                             | Public surface                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`@latkit/network`](reference/network/index.md)     | The `Network` controller and its `CHANNELS`, `OPTIONS`, and `PROJECTIONS` registries |
| [`@latkit/monitor`](reference/monitor/index.md)     | Monitor renderer, readings, events, and display options                              |
| [`@latkit/gpu`](reference/gpu/index.md)             | Core WebGPU device acquisition, shared device leases, and canvas presentation        |
| [`@latkit/colormaps`](reference/colormaps/index.md) | The `COLORMAPS` registry, transfer functions, and CSS gradients                      |
| [`@latkit/model`](reference/model/index.md)         | Columnar network model, `Topology`, `Item`, `Series`, fields, runs, grids, sources   |
| [`@latkit/port`](reference/port/index.md)           | Ports over workers, webviews, and sockets; protocols served and connected over them  |
| [`@latkit/remote`](reference/remote/index.md)       | A model's source, runner, grids, and results served across a port                    |

## Common entrypoints

- [`createNetwork`](reference/network/index.md#createnetwork) creates a network canvas controller; the `Network` interface on that page is everything a host does with it.
- [`Topology`](reference/model/index.md), [`Item`](reference/model/index.md), and [`Series`](reference/model/index.md) are the shapes every renderer loads and returns, defined once in the model package.
- [`createMonitor`](reference/monitor/index.md#createmonitor) creates a monitor canvas controller.
- [`requestDevice`](reference/gpu/index.md#requestdevice) requests a native Core WebGPU device; [`createDevicePool`](reference/gpu/index.md#createdevicepool) shares one among many renderers.
- [`createPresentation`](reference/gpu/index.md#createpresentation) configures a caller-owned canvas.
- [`colormap`](reference/colormaps/index.md#colormap) returns a normalized color transfer function; [`COLORMAPS`](reference/colormaps/index.md#colormaps) names and labels every preset.
- [`protocol`](reference/port/index.md#protocol) declares the contract both ends of a service import; [`serve`](reference/port/index.md#serve) answers it and [`connect`](reference/port/index.md#connect) calls it.
- [`connectSource`](reference/remote/index.md#connectsource) opens the model a `serveSource` peer serves.
- [`connectResults`](reference/remote/index.md#connectresults) reads the results a `serveResults` peer holds; [`collect`](reference/model/index.md#collect) folds a read into a `Series`.

```{toctree}
:maxdepth: 2
:hidden:
:glob:

reference/index
reference/**/*
```
