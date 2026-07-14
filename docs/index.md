# Latkit

```{image} _static/banner.png
:alt: Latkit visualization banner
:width: 100%
```

Latkit is a TypeScript package family for browser-based WebGPU visualization of network topology and monitor data.

Use it when you need to render large graph-like systems, stream many time-oriented readings, or share colormap behavior across those visualizations.

## Start here

| Goal                                | Read                                              |
| ----------------------------------- | ------------------------------------------------- |
| Install packages and run an example | [Get started](getting-started.md)                 |
| Render a small network              | [Create a network view](network-quickstart.md)    |
| Render monitor traces               | [Create a monitor](monitor-quickstart.md)         |
| Shape real data for the renderer    | [Topology and channels](topology-and-channels.md) |
| Look up public types and methods    | [API reference](api/index.md)                     |

## Requirements

Latkit packages are ESM modules for modern browser applications. The rendering packages require a browser with WebGPU support. The repository uses Node.js 22 or newer for local development.

## Packages

| Package             | Use it for                                          |
| ------------------- | --------------------------------------------------- |
| `@latkit/network`   | Interactive WebGPU network topology views           |
| `@latkit/monitor`   | WebGPU time-series and signal monitor views         |
| `@latkit/gpu`       | Core WebGPU device and presentation primitives      |
| `@latkit/colormaps` | Named colormaps, labels, and CSS gradients          |
| `@latkit/model`     | Shared model primitives as the package family grows |

```{toctree}
:maxdepth: 2
:caption: Learn

getting-started
network-quickstart
monitor-quickstart
```

```{toctree}
:maxdepth: 2
:caption: How-to

topology-and-channels
colormaps
lifecycle
```

```{toctree}
:maxdepth: 2
:caption: Explanation

architecture
```

```{toctree}
:maxdepth: 2
:caption: Reference

api/index
```

```{toctree}
:maxdepth: 1
:caption: Project

release-process
about-author
```
