<p align="center">
  <img src="docs/images/opening.png" width="100%" alt="The ACTIVSg70k grid on a globe as one 765 kV line opens. Buses rise with their frequency, branches that pick up the line's power glow amber, and branches that lose flow glow cyan">
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/_static/logo-dark.svg">
    <img src="docs/_static/logo.svg" width="40" alt="" align="center">
  </picture>
  latkit
</h1>

<p align="center">
  A GPU-accelerated visualization library for large networks, such as power grids:<br>
  interactive views in the browser with WebGPU, and images and video from the command line.
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
import { Data, View, field, load } from 'latkit';

await load();
const grid = new Data('grid').set('Bus', [101, 102], { x: [0, 30], y: [0, 20], kv: [230, 115] });

const view = await View.create(document.querySelector('canvas')!, {
  space: 'plane',
  marks: [
    {
      vertices: grid.table('Bus'),
      position: ['$x', '$y'],
      radius: 6,
      color: field('kv').colormap('viridis'),
    },
  ],
});

grid.set('Bus', [102], { kv: [345] }); // drawn the next frame
```

A scene is plain data, with types from latkit's schema. `JSON.stringify(scene)` writes the JSON the
command line reads.

## On the command line

Write the same scene and data as JSON to render a picture, or a video with `--frames`:

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
      "vertices": ["grid", "Bus"],
      "position": ["$x", "$y"],
      "radius": 6,
      "color": { "colormap": "viridis", "value": "$kv" }
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
  <a href="https://latkit.readthedocs.io/en/latest/examples/texas.html"><img src="docs/images/texas.png" width="32%" alt="Two thousand buses of a synthetic Texas grid: generators as amber discs sized by output, comets along its highest-voltage lines"></a>
  <a href="https://latkit.readthedocs.io/en/latest/examples/frequency.html"><img src="docs/images/frequency.png" width="32%" alt="The speed of 1,456 machines over ten seconds after a fault. Machines near the fault are bright and swing hardest, and far ones are dark"></a>
  <a href="https://latkit.readthedocs.io/en/latest/examples/globe.html"><img src="docs/images/globe.png" width="32%" alt="Great-circle routes between forty of the world's great cities on a globe, with comets flowing along them"></a>
  <a href="https://latkit.readthedocs.io/en/latest/examples/diagram.html"><img src="docs/images/diagram.png" width="32%" alt="A microgrid controller as blocks in nested groups, with wires routed port to port and a feedback loop"></a>
  <a href="https://latkit.readthedocs.io/en/latest/examples/torus.html"><img src="docs/images/torus.png" width="32%" alt="Sixty-four filaments in cyan, amber, and coral, twisting around a three-dimensional torus knot"></a>
  <a href="https://latkit.readthedocs.io/en/latest/examples/clifford.html"><img src="docs/images/clifford.png" width="32%" alt="A Clifford strange attractor of 260,000 translucent points, colored by the direction of each step"></a>
</p>

latkit drew every picture here. [The examples](https://latkit.readthedocs.io/en/latest/examples/) show the code for each one.

## Documentation

Guides, examples, and the reference are on [Read the Docs](https://latkit.readthedocs.io), and the
Rust API is on [docs.rs](https://docs.rs/latkit). [Contributing](CONTRIBUTING.md) covers the
repository and how to build it.

Created by [Luke Lowery](https://lukelowry.github.io/). [MIT License](LICENSE).
