# API reference

All public imports use package roots. `@latkit/colormaps` and `@latkit/port` have been removed; there are no compatibility exports.

| Package                                         | Current surface                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`@latkit/model`](reference/model/index.md)     | Native `Model`, `Document`, `Recording`, schema, query, and service contracts            |
| [`@latkit/connect`](reference/connect/index.md) | `connect`, `serve`, connections, and transport implementations                           |
| [`@latkit/gpu`](reference/gpu/index.md)         | `Gpu`, frame preparation, resources, native fields, text, strokes, colors, and colormaps |
| [`@latkit/network`](reference/network/index.md) | `createNetwork`, `Network`, native field bindings, camera, styling, and input            |

Monitor, diagram, embed, and video await migration. Their older APIs do not represent the new shared contract. The generated reference requires those packages to typecheck before a full documentation build.

## Common entrypoints

- `createGpu` owns shared resource budgets, caching, and submission.
- `createCanvasView` schedules a renderer onto an application-owned canvas.
- `createNetwork` borrows native model sources and a GPU; `attachNetworkInput` connects DOM gestures.
- `colormaps` provides 46 immutable palette values. `createColormap` authors a value; `reverseColormap` reverses it.
- `parseColor` parses absolute CSS colors without a DOM. `resolveColor` explicitly resolves an element's context.
- `colormapCss` and `sampleColormap` use the same rendering table as `colormapShader`, `Gpu.colormapLayout`, and `Preparation.colormap`.

See [network usage](../network-quickstart.md) and [the color contract](../colormaps.md) for examples.

```{toctree}
:maxdepth: 2
:hidden:
:glob:

reference/index
reference/**/*
```
