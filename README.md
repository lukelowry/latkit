# Latkit

[![CI](https://github.com/lukelowry/latkit/actions/workflows/ci.yml/badge.svg)](https://github.com/lukelowry/latkit/actions/workflows/ci.yml)

Columnar data drawn as vertices, edges, lines, and areas on the GPU: networks on a plane, a map, or
a globe, plots of sampled fields, and block diagrams, from a scene and named data. One Rust crate
draws them, in the browser through the npm package and natively through the CLI.

| Part                              | Use                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| [`latkit`](crates/latkit)         | The library: data, expressions, scenes, views, pictures, and video                         |
| [npm `latkit`](npm)               | The library in the browser, its scenes as JSON with generated types                        |
| [`latkit-cli`](crates/latkit-cli) | Scenes of JSON or binary data rendered to images and videos                                |
| [Examples](npm/examples)          | Every feature on a page, and the browser gate that drives them                             |
| [Benchmark](benchmark)            | Each scenario's phases up its sizes, held to committed work and times                      |
| [Docs](docs)                      | How-tos for the npm package and the CLI, on [Read the Docs](https://latkit.readthedocs.io) |

```ts
import { loadLatkit, Patch, type Scene } from 'latkit';

const { Data, Gpu } = await loadLatkit();
const gpu = await Gpu.create();
const data = new Data('grid').apply(new Patch().replace('Bus', [1, 2], { x: [0, 30], y: [0, 20] }));
const scene: Scene = {
  space: 'plane',
  marks: [{ vertices: { of: ['grid', 'Bus'], position: ['x', 'y'], radius: 6 } }],
};
const view = gpu.view(scene);
gpu.canvas(document.querySelector('canvas')!).show([view]);
view.setData(data);
```

## Develop

Requires Rust (pinned in `rust-toolchain.toml`), Node.js 24, and pnpm 10.30.

```sh
pnpm install
cargo xtask examples --open   # the example pages at http://127.0.0.1:5200
cargo xtask check             # format, lint, test, typecheck, and the browser gate
cargo xtask bench --quick     # every benchmark scenario once, at its smallest size
```

Created by [Luke Lowery](https://lukelowry.github.io/). [MIT License](LICENSE).
