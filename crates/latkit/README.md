latkit stores and queries tabular data and draws it as vertices, edges, lines, and areas.
Browser views use WebGL2. Native views use Vulkan, Metal, DX12, or OpenGL.
[Guides](https://latkit.readthedocs.io) | [Rust API](https://docs.rs/latkit)

```sh
cargo add latkit
```

```rust
use latkit::{Data, Ids, Patch, Query, Table, field};

fn main() -> Result<(), latkit::Error> {
    let grid = Data::new("grid");
    grid.apply(Patch::new().replace(Table::new("Bus", Ids::count(2)).field("kv", vec![115.0, 230.0])))?;
    let high_voltage = grid.snapshot().query(&Query::of("Bus").filter(field("kv").ge(200.0)))?;
    assert_eq!((high_voltage.table.len(), high_voltage.total), (1, 1));
    Ok(())
}
```

## Features

| Cargo feature              | Use                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `default-features = false` | Datasets, queries, GeoJSON, expressions, colormaps, and image encoding without a GPU dependency. |
| `gpu` (default)            | Scenes, views, picking, layouts, and rendering to wgpu targets.                                  |
| `native`                   | System fonts, files, background jobs, and H.264 encoding on Windows.                             |
| `web`                      | Browser rendering with WebGL2 on `wasm32-unknown-unknown`.                                       |
| `wgsl`                     | An in-browser WGSL compiler for custom shaders. Adds about 1 MB to the WebAssembly build.        |

Use `cargo add latkit --no-default-features` for data processing alone.
For the binary layout, see the [LATK format specification](https://latkit.readthedocs.io/en/latest/formats.html#bytes).

License and third-party notices are included in `LICENSE`, `THIRD_PARTY.md`, and `colormaps/NOTICES.md`.
