# Installation

## JavaScript

Install the browser package with npm. Rendering requires WebGL2.

```sh
npm install latkit
```

[Run the JavaScript quickstart](quickstart/javascript.md) or [configure the WebAssembly assets](deploying.md#assets-and-workers).

## Command line

Install the CLI to render scenes from files.

```sh
cargo install latkit-cli
latkit --version
```

[Animate a six-bus network](quickstart/cli.md).

## Rust

Add the library to your crate with GPU support.

```sh
cargo add latkit
```

For datasets and queries alone, use:

```sh
cargo add latkit --no-default-features
```

[Run the Rust quickstart](quickstart/rust.md).
