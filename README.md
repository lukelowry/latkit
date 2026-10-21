<p align="center">
  <img src="docs/images/hero.webp" width="100%" alt="Seventy thousand buses of a synthetic United States grid, colored by frequency as a 765 kV line opens">
</p>

<h1 align="center">latkit</h1>

<p align="center">
  Networks, maps, plots, and diagrams of millions of rows, drawn on the GPU:<br>
  in the browser with WebGPU, and as pictures and video from the command line.
</p>

<p align="center">
  <a href="https://github.com/lukelowry/latkit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lukelowry/latkit/ci.yml?branch=main&label=CI"></a>
  <a href="https://www.npmjs.com/package/latkit"><img alt="npm" src="https://img.shields.io/npm/v/latkit?label=npm"></a>
  <a href="https://crates.io/crates/latkit"><img alt="crates.io" src="https://img.shields.io/crates/v/latkit?label=crates.io"></a>
  <a href="https://docs.rs/latkit"><img alt="docs.rs" src="https://img.shields.io/docsrs/latkit?label=docs.rs"></a>
  <a href="https://latkit.readthedocs.io"><img alt="Guides" src="https://img.shields.io/readthedocs/latkit?label=guides"></a>
  <a href="https://crates.io/crates/latkit"><img alt="Rust version" src="https://img.shields.io/crates/msrv/latkit?label=rust"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

## Install

```sh
npm install latkit          # in the browser
cargo install latkit-cli    # on the command line: pictures and video
cargo add latkit            # in Rust
```

## In the browser

```ts
import { loadLatkit, Patch, field, type Scene } from 'latkit';

const { Data, Gpu } = await loadLatkit();
const data = new Data('grid').apply(
  new Patch().replace('Bus', [101, 102], { x: [0, 30], y: [0, 20], kv: [230, 115] }),
);
const scene: Scene = {
  space: 'plane',
  marks: [
    {
      vertices: {
        of: ['grid', 'Bus'],
        position: ['x', 'y'],
        radius: 6,
        color: field('kv').colormap('viridis'),
      },
    },
  ],
};

const gpu = await Gpu.create();
const view = gpu.view(scene);
gpu.canvas(document.querySelector('canvas')!).show([view]);
view.setData(data);
view.fit();
```

Scenes, expressions, and patches are plain data, typed from latkit's schema: `latkit/core` builds
them without loading WebAssembly, in a worker or on a server.

## On the command line

The same scene and data, as JSON, render to a picture, or with `--frames` to video:

```sh
latkit render scene.json --data grid.json --output grid.png
latkit render scene.json --data grid.json --frames frames.jsonl --fps 60 --output grid.mp4
```

<details>
<summary><code>scene.json</code> and <code>grid.json</code></summary>

`scene.json`

```json
{
  "space": "plane",
  "marks": [
    {
      "vertices": {
        "of": ["grid", "Bus"],
        "position": ["x", "y"],
        "radius": 6,
        "color": { "colormap": "viridis", "value": { "field": "kv" } }
      }
    }
  ]
}
```

`grid.json`

```json
{
  "name": "grid",
  "patch": [
    {
      "replace": {
        "table": "Bus",
        "ids": [101, 102],
        "fields": { "x": [0, 30], "y": [0, 20], "kv": [230, 115] }
      }
    }
  ]
}
```

</details>

## Gallery

<p align="center">
  <a href="npm/examples/src/examples/power-flow"><img src="docs/images/power-flow.webp" width="49%" alt="Texas substations as pie markers on a map, lines colored by loading, power flowing along them"></a>
  <a href="npm/examples/src/examples/linked-views"><img src="docs/images/linked-views.webp" width="49%" alt="A surface of 400 sensors in 3D beside three selected signal traces over ten seconds"></a>
  <a href="npm/examples/src/examples/diagram"><img src="docs/images/diagram.webp" width="98.5%" alt="A block diagram of a water plant: grouped blocks, ports, and routed wires"></a>
  <a href="crates/latkit-cli/examples/cli-gallery"><img src="docs/images/helios.webp" width="32%" alt="A synthetic transmission network in five concentric rings"></a>
  <a href="docs/images/torus-silk.png"><img src="docs/images/torus-silk.png" width="32%" alt="Torus Silk: 64 cyan, amber, and coral filaments woven into a three-dimensional torus knot, rendered with latkit-cli"></a>
  <a href="docs/images/golden-bloom.png"><img src="docs/images/golden-bloom.png" width="32%" alt="Golden Bloom: 32,000 golden-angle seeds forming a spiral of sapphire, rose, and amber, rendered with npm latkit's WASM renderer"></a>
</p>

<p align="center">
  <sub>From the <a href="npm/examples">example pages</a> and the <a href="crates/latkit-cli/examples">command-line examples</a>, with Torus Silk and Golden Bloom rendered using the published latkit-cli and npm latkit 0.2.0 releases.</sub>
</p>

## Repository

| Part                              | What it is                                                     |
| --------------------------------- | -------------------------------------------------------------- |
| [`latkit`](crates/latkit)         | The Rust library: data, expressions, scenes, views, and video  |
| [npm `latkit`](npm)               | The library in the browser, with types for every scene         |
| [`latkit-cli`](crates/latkit-cli) | Pictures and video of scenes, from JSON or binary data         |
| [Examples](npm/examples)          | Every feature on a page, and the browser gate that drives them |
| [Benchmark](benchmark)            | Every scenario's phases up its sizes, held to committed work   |
| [Docs](docs)                      | The guides, on [Read the Docs](https://latkit.readthedocs.io)  |

The `@latkit/*` TypeScript packages, a lighter alternative without WebAssembly, are maintained on
the [`npm/js`](https://github.com/lukelowry/latkit/tree/npm/js) branch.

## Develop

Requires Rust (pinned in `rust-toolchain.toml`), Node.js 24, and pnpm 10.30.

```sh
pnpm install
cargo xtask examples --open   # the example pages at http://127.0.0.1:5200
cargo xtask check             # format, lint, test, typecheck, and the browser gate
cargo xtask bench --quick     # every benchmark scenario once, at its smallest size
```

Created by [Luke Lowery](https://lukelowry.github.io/). [MIT License](LICENSE).
