# latkit

Columnar data, queries, and scenes rendered with WebGPU, Vulkan, Metal, or DX12.
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

- `default-features = false`: data, patches, LATK, JSON reading, queries, expressions, colormaps,
  GeoJSON, and images; no GPU dependency.
- `gpu` (default): scenes, views, picking, layouts, and rendering into wgpu targets.
- `native`: system fonts, file loading, jobs, and Windows Media Foundation video.
- `web`: browser integration on `wasm32-unknown-unknown`.

`cargo install latkit-cli` installs the `latkit` executable. `npm install latkit` installs
the browser runtime and plain-data builders.

LATK v1 uses 64-bit absolute frame indexes. Sampled values use `f32`; coordinates use `f64`.
See the [format specification](https://latkit.readthedocs.io/en/latest/formats.html).

MIT licensed. Notices are included in `THIRD_PARTY.md` and `colormaps/NOTICES.md`.
