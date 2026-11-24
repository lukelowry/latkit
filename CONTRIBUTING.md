# Contributing

## Repository

| Part                              | What it is                                                         |
| --------------------------------- | ------------------------------------------------------------------ |
| [`latkit`](crates/latkit)         | The Rust library: data, expressions, scenes, views, and video      |
| [`latkit-js`](crates/latkit-js)   | The WebAssembly bindings the npm package wraps                     |
| [npm `latkit`](npm)               | The library in the browser, with types for every scene             |
| [`latkit-cli`](crates/latkit-cli) | Pictures and video of scenes, from JSON or binary data             |
| [Examples](npm/examples)          | Small examples to copy, and the browser gate that tests them       |
| [Benchmark](benchmark)            | Every scenario at a few sizes, checked against committed baselines |
| [Docs](docs)                      | The site on [Read the Docs](https://latkit.readthedocs.io)         |
| [Gallery](docs/gallery)           | The documentation's pictures, each drawn by latkit                 |
| [`xtask`](xtask)                  | Repository tasks, run as `cargo xtask <task>`                      |

The `@latkit/*` TypeScript packages, a lighter alternative without WebAssembly, are maintained on
the [`npm/js`](https://github.com/lukelowry/latkit/tree/npm/js) branch.

## Develop

You need Rust (pinned in `rust-toolchain.toml`), Node.js 24, pnpm 10.30, and uv for the docs.

```sh
pnpm install
cargo xtask examples --open   # the example pages at http://127.0.0.1:5200
cargo xtask check             # every CI job's steps: format, lint, test, browser gate
cargo xtask bench --quick     # every benchmark scenario once, at its smallest size
```

## Documentation

The site builds with Python alone, from checked-in files. To rebuild the site and its generated
parts:

```sh
uv run --project docs --group docs sphinx-build -W -b html docs target/docs   # the site
LATKIT_BLESS=1 cargo test -p latkit-cli              # the CLI's command tree, docs/reference/cli.json
node npm/build.mjs compile npm                        # refresh declarations and bundle the browser worker
node npm/docs.mjs                                    # regenerate the three reference pages
LATKIT_BLESS=1 cargo test -p latkit --test schema    # the palette: latkit's default themes
cargo build --locked -p latkit-cli --profile cli
node docs/gallery/render.ts [name...]                # the pictures, drawn by the latkit CLI
node benchmark/docs.ts                               # the performance table, from a baseline
```

Edit JavaScript API comments in `npm/src`, scene and result descriptions in Rust, and CLI help
in `crates/latkit-cli/src/args.rs`. The reference generator reads public package exports and
groups them by module. The schema types have their own topic order.

Drawing the pictures also needs the npm package, built with `cargo xtask wasm`.

## Browser performance checks

The browser gate compiles each pipeline cold in Chrome (800 ms limit), then opens each example
without a shader cache, exercises input, and exports an image. Console errors, first-use
pipeline compilation, and missing exports fail immediately. A page gets one cold retry if a
view takes over 1,000 ms to draw its first frame or the page misses consecutive display frames.
SwiftShader runs the compilation check only.

latkit requests pipelines before drawing and polls
[`KHR_parallel_shader_compile`](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/)
where available. Without the extension, checking link status can block. Built-in shaders are
translated to GLSL at build time. Custom markers and shades are translated on first use.
See the [benchmark notes](benchmark/README.md) for workloads and thresholds.

[Releasing](RELEASING.md) covers versions and publishing.
