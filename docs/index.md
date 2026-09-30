# Latkit

```{image} _static/banner.png
:alt: Latkit visualization banner
:width: 100%
```

Latkit is a TypeScript package family for browser-based WebGPU visualization of network topology, block diagrams, and monitor data.

Use it when you need to render large graph-like systems, stream many time-oriented readings, or share colormap behavior across those visualizations.

> Migration status: model, connect, GPU, and network use the new contracts. Monitor, diagram, embed, and video await migration. Some older guides remain marked as historical.

## Start here

| Goal                                  | Read                                              |
| ------------------------------------- | ------------------------------------------------- |
| Install packages and run an example   | [Get started](getting-started.md)                 |
| Render a small network                | [Create a network view](network-quickstart.md)    |
| Render monitor traces                 | [Create a monitor](monitor-quickstart.md)         |
| Render and edit a block diagram       | [Create a block diagram](diagram-quickstart.md)   |
| Shape real data for the renderer      | [Topology and channels](topology-and-channels.md) |
| Serve a model from a worker or server | [Ports and protocols](ports-and-protocols.md)     |
| Look up public types and methods      | [API reference](api/index.md)                     |

## Requirements

Latkit packages are ESM modules for modern browser applications. The rendering packages require a browser with WebGPU support. The repository uses Node.js 24 for local development.

## Packages

| Package           | Use it for                                                     |
| ----------------- | -------------------------------------------------------------- |
| `@latkit/network` | Interactive WebGPU network topology views                      |
| `@latkit/monitor` | WebGPU time-series and signal monitor views                    |
| `@latkit/diagram` | WebGPU block diagrams with automatic layout and edit proposals |
| `@latkit/embed`   | `latkit-network` and `latkit-monitor` custom elements          |
| `@latkit/gpu`     | Shared WebGPU fields, text, colors, resources, and frames      |
| `@latkit/model`   | Native model, document, recording, and query contracts         |
| `@latkit/connect` | Native model services over transports                          |

```{toctree}
:maxdepth: 2
:caption: Learn

getting-started
network-quickstart
monitor-quickstart
diagram-quickstart
```

```{toctree}
:maxdepth: 2
:caption: How-to

topology-and-channels
colormaps
lifecycle
ports-and-protocols
document-sessions
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
