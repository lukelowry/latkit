<p align="center">
  <img src="docs/_static/banner.png" alt="Latkit visualization banner" width="100%">
</p>

# Latkit

Latkit is a TypeScript package family for browser-based WebGPU visualization of network topology and monitor data.

It provides imperative renderer controllers, typed data shapes, and shared colormap helpers for applications that need to inspect graph-like systems or many time-oriented readings in the browser.

## Requirements

- Node.js 22 or newer for local development.
- A WebGPU-capable browser for `@latkit/network` and `@latkit/monitor`.
- An ESM-capable bundler or dev server for downstream apps.

## Packages

| Package             | Use it for                                          |
| ------------------- | --------------------------------------------------- |
| `@latkit/network`   | Interactive WebGPU network topology views           |
| `@latkit/monitor`   | WebGPU time-series and signal monitor views         |
| `@latkit/gpu`       | Native Core WebGPU device acquisition               |
| `@latkit/colormaps` | Named colormaps, labels, and CSS gradients          |
| `@latkit/model`     | Shared model primitives as the package family grows |

## Install

```sh
npm install @latkit/gpu @latkit/network @latkit/colormaps
```

or:

```sh
npm install @latkit/gpu @latkit/monitor @latkit/colormaps
```

## Run examples

Run each example in its own shell:

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

```sh
pnpm --filter @latkit/monitor-example dev
```

The network example runs at `http://127.0.0.1:5188`. The monitor example runs at `http://127.0.0.1:5190`.

## Documentation

The docs live in `docs/` and are written in MyST Markdown for Sphinx and Read the Docs. API reference pages are generated from the public TypeScript package entrypoints.

```sh
pnpm docs:build
```

Use `pnpm docs:api` only when you want to inspect generated API Markdown without building the Sphinx HTML site.
