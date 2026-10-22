# Contributing

## Repository

| Part                              | What it is                                                     |
| --------------------------------- | -------------------------------------------------------------- |
| [`latkit`](crates/latkit)         | The Rust library: data, expressions, scenes, views, and video  |
| [npm `latkit`](npm)               | The library in the browser, with types for every scene         |
| [`latkit-cli`](crates/latkit-cli) | Pictures and video of scenes, from JSON or binary data         |
| [Examples](npm/examples)          | Every feature on a page, and the browser gate that drives them |
| [Benchmark](benchmark)            | Every scenario's phases up its sizes, held to committed work   |
| [Docs](docs)                      | The site on [Read the Docs](https://latkit.readthedocs.io)     |
| [Gallery](docs/gallery)           | The documentation's pictures, each drawn by latkit             |

The `@latkit/*` TypeScript packages, a lighter alternative without WebAssembly, are maintained on
the [`npm/js`](https://github.com/lukelowry/latkit/tree/npm/js) branch.

## Develop

Requires Rust (pinned in `rust-toolchain.toml`), Node.js 24, pnpm 10.30, and for the docs, uv.

```sh
pnpm install
cargo xtask examples --open   # the example pages at http://127.0.0.1:5200
cargo xtask check             # format, lint, test, typecheck, and the browser gate
cargo xtask bench --quick     # every benchmark scenario once, at its smallest size
```

## Documentation

The site builds with Python alone, from what the repository checks in; each generated part has the
command that writes it again:

```sh
uv run --project docs --group docs sphinx-build -W -b html docs target/docs   # the site
node npm/docs.mjs                                    # the JavaScript API and type references
LATKIT_BLESS=1 cargo test -p latkit --test schema    # the palette: latkit's default themes
cargo build --locked -p latkit-cli --profile cli
node docs/gallery/render.ts [name...]                # the pictures, drawn by the latkit CLI
node benchmark/docs.ts                               # the performance table, from a baseline
```

[Releasing](RELEASING.md) covers versions and publishing.
