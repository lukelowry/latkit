# latkit CLI

Validate scene JSON and render PNG images using the same Rust renderer and data format as the browser package.

```sh
cargo install --path crates/latkit-cli --locked --profile cli
latkit validate scene.json --data grid.bin
latkit render scene.json --data grid.bin --output grid.png
latkit render scene.json -d grid.bin -d prices.bin -o grid.png --width 2400 --height 1350 --pixel-ratio 2
latkit render scene.json -d grid.bin -o grid.png --font ./fonts/Inter.ttf --elapsed 2 --at 1700000000
cat scene.json | latkit render - -d grid.bin -o - > grid.png
latkit --diagnostics json validate scene.json -d grid.bin
```

The package is `latkit-cli`; the executable is `latkit`. Once published, install it with
`cargo install latkit-cli --locked`. Publishing the library must precede publishing the CLI.
Native executables are OS/architecture specific. Rust applications depend directly on `latkit`
instead of spawning the CLI. Browser applications use the existing npm/WASM package.

The workspace's `cli` profile optimizes for executable size, strips symbols, and inherits fat LTO
and one codegen unit from `release`. Build it with `cargo build --locked -p latkit-cli --profile cli`;
the executable is in `target/cli/`. This profile preserves unwinding for native worker error
handling. GPU builds include DX12, Metal, Vulkan, and browser WebGPU as applicable to the target;
the unused OpenGL/GLES backend is disabled. Keep `Cargo.lock` when building distributions: it also
unifies the font parser versions shared by shaping and rasterization. Compress the executable in
a platform archive for distribution; PDB files and Cargo build artifacts are not runtime inputs.

See [the CLI gallery](../../examples/cli-gallery/README.md) for rendered images, scene JSON,
datasets, and commands to reproduce them.

`render` automatically fits the data and settles layout, uploads, labels, and finite transitions.
It needs a working Vulkan, Metal, or DX12 adapter/driver; no window is opened. `validate` never
creates a GPU and checks the same expressions as rendering. It does not check runtime GPU limits,
font availability, or fetch remote resources.

- Scene JSON is the existing scene format, with no CLI wrapper. Dataset files are `Data::to_bytes()`
  output, read by `Data::from_bytes()`. Dataset names come from the bytes; duplicates fail.
- Paths are relative to the current working directory. One scene or dataset may read stdin (`-`).
- `--output` is required: `.png`, or `-` for binary stdout. Successful commands print no status text.
  Diagnostics go to stderr. File output replaces the destination atomically after successful encoding;
  stdout is a stream and can be partial if writing fails.
- Defaults: 1600 × 900 physical pixels, pixel ratio 1, latest dataset sample, elapsed effect time 0,
  and a 30-second budget for GPU initialization and capture. `--pixel-ratio` changes logical sizing,
  not the output dimensions. `--at` uses the dataset's own coordinate units; `--elapsed` uses seconds.
- `--transparent` preserves alpha. `--timeout` must be positive. Timeouts are cooperative and cannot
  interrupt a blocking OS/driver call; they do not cover reading input or PNG encoding/writing.
- Fonts load on first text use. Repeated `--font` options use only those files, with the first family
  as the generic fallback. Supply every needed script for portable results. No fonts are bundled.
- Exit codes: **0** success, **1** input/validation/render/I/O failure, **2** argument usage error.
  `--diagnostics json` emits one JSON object on stderr for operational failures, with `code`, `path`
  (name/index array), `message`, and optional `source`. Argument errors retain standard CLI help.

An example scene for a binary dataset named `grid`, with table `Bus` and numeric `x`/`y` fields:

```json
{
  "space": "plane",
  "marks": [{ "vertices": { "of": ["grid", "Bus"], "position": ["x", "y"] } }]
}
```

The equivalent native library workflow requires `latkit = { version = "0.1", features = ["native", "serde"] }`:

```rust,no_run
use std::{fs::File, time::Duration};
use latkit::{Data, Fit, Gpu, Scene, Shot, View, host::Native};

async fn render(scene: Scene, data: Vec<Data>) -> Result<(), Box<dyn std::error::Error>> {
    scene.validate(&data)?;
    let gpu = Gpu::new().await?;
    gpu.set_host(Native::new()); // Or Native::from_fonts([font_bytes])?
    let mut view = View::new(&gpu, scene)?;
    for dataset in data { view.set_data(dataset); }
    view.fit(Fit::All);
    let image = Shot::new([1600, 900]).elapsed(Duration::ZERO).image(&mut [&mut view]).await?;
    image.write_png(File::create("grid.png")?)?;
    Ok(())
}
```

Reuse the GPU, host, and view for repeated exports. A desktop application uses that same host and
`View::render` with its own wgpu surface and event loop. The library adds no window framework,
HTTP client, or async runtime. The CLI adds a minimal-feature `clap` parser and `tempfile` for portable
file replacement. Native fonts are behind the `native` feature and excluded from WASM builds.

Schema generation, native video encoding, remote input, a GUI shell, and prebuilt binary release
automation are separate work; none is required for these render/validate commands.
