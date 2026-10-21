# Rust embedding

For CPU data processing, opt out of the default GPU feature:

```toml
[dependencies]
latkit = { version = "0.1", default-features = false }
```

```rust
use latkit::{Data, Ids, Patch, Query, Table, field};

let mut data = Data::new("grid");
data.apply(Patch::new().replace(
    Table::new("Bus", Ids::count(2)).field("kv", vec![115.0, 230.0]),
))?;
let (rows, total) = data.query(&Query::of("Bus").filter(field("kv").ge(200.0)))?;
let saved = data.to_bytes();
let restored = Data::from_bytes(&saved)?;
```

`Data::load` and `Patch::load` accept a `resource::Fetch` implementation for binary slices.
Implement `fetch(&Request) -> Pending<Vec<u8>>`; `Pending::ready` wraps immediate results, and
`Pending::new` returns a resolver for asynchronous work. A rendering `Host` automatically
implements this smaller interface, so existing native and browser hosts work unchanged.

Enable `gpu` for scenes, views, and wgpu rendering; `native` adds system fonts, jobs, files, and
Windows H.264. `web` enables browser integration for the WASM target. Native file loading does
not include an HTTP client; applications can provide one through `Fetch` or `Host`.

## Share an existing device

```rust
let gpu = latkit::Gpu::from_wgpu(device.clone(), queue.clone())?;
let events = gpu.device_events();
let loss = events.clone();
device.set_device_lost_callback(move |_, _| loss.lost());
device.on_uncaptured_error(std::sync::Arc::new(move |error| events.error(&error)));
```

Forward these events from your application's existing callbacks. `from_wgpu` validates device
limits and preserves callback ownership. Clone one `Gpu` for views that should share caches and
budgets. `Gpu::new` owns its device and installs its own callbacks. Device loss requires a new
device and views; datasets and scene descriptions can be retained.

The [Rust API reference](https://docs.rs/latkit) documents each type, method, feature, and example.
The [format specification](formats.md#bytes) describes cross-language LATK storage.
