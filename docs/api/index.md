# API reference

The API reference is generated from the published package entrypoints with TypeDoc. Start with the package page that matches the renderer or helper you are using.

| Package                                             | Public surface                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`@latkit/network`](reference/network/index.md)     | The `Network` controller and its `CHANNELS`, `OPTIONS`, and `PROJECTIONS` registries             |
| [`@latkit/monitor`](reference/monitor/index.md)     | Monitor renderer, readings, events, and display options                                          |
| [`@latkit/diagram`](reference/diagram/index.md)     | The `Diagram` controller, its `CHANNELS` and `OPTIONS` registries, and `arrange`                 |
| [`@latkit/gpu`](reference/gpu/index.md)             | What every renderer shares: devices, presentation, frames, attach, channels, colormap textures   |
| [`@latkit/colormaps`](reference/colormaps/index.md) | `RGBA`, `Colormap`, the `COLORMAPS` registry, gradients, and `parseColor`                        |
| [`@latkit/model`](reference/model/index.md)         | The `Model`, its runs, recordings, fields, and grids, the structures renderers load, its sources |
| [`@latkit/port`](reference/port/index.md)           | Ports, protocols and their checks, and a model and its recordings served across a port           |

## Common entrypoints

- [`createNetwork`](reference/network/index.md#createnetwork) creates a network controller that attaches to any canvas; the `Network` interface on that page is everything a host does with it.
- [`createModel`](reference/model/index.md#createmodel) builds the model every question goes to: `field` resolves what a renderer binds, `run` fills a recording, and `grid` tables a class.
- [`Topology`](reference/model/index.md), [`Item`](reference/model/index.md), [`Series`](reference/model/index.md), and [`Domain`](reference/model/index.md) are the shapes every renderer loads and returns, defined once in the model package.
- [`createMonitor`](reference/monitor/index.md#createmonitor) creates a monitor controller that attaches to any canvas.
- [`createDiagram`](reference/diagram/index.md#creatediagram) creates a block-diagram controller that attaches to any canvas; the `Diagram` interface on that page is everything a host does with it. [`Netlist`](reference/model/index.md) is the shape it loads.
- [`devices`](reference/gpu/index.md#devices) is the realm-wide device pool every controller leases from; [`requestDevice`](reference/gpu/index.md#requestdevice) requests a native Core WebGPU device and [`createDevicePool`](reference/gpu/index.md#createdevicepool) makes a private pool.
- [`createPresentation`](reference/gpu/index.md#createpresentation) configures a caller-owned canvas; [`createFrameLoop`](reference/gpu/index.md#createframeloop) schedules its frames.
- [`colormap`](reference/colormaps/index.md#colormap) returns a normalized color transfer function; [`COLORMAPS`](reference/colormaps/index.md#colormaps) names and labels every preset.
- [`protocol`](reference/port/index.md#protocol) declares the contract both ends of a service import; [`serve`](reference/port/index.md#serve) answers it and [`connect`](reference/port/index.md#connect) calls it.
- [`connectModel`](reference/port/index.md#connectmodel) opens the model a `serveModel` peer serves; [`connectRecording`](reference/port/index.md#connectrecording) opens the recording a `serveRecording` peer serves.

```{toctree}
:maxdepth: 2
:hidden:
:glob:

reference/index
reference/**/*
```
