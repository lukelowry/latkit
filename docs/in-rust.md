# Use latkit in Rust

For queries and file conversion without GPU dependencies, install the crate with:

```sh
cargo add latkit --no-default-features
```

The [Rust API overview](https://docs.rs/latkit/latest/latkit/) shows how to create a dataset,
apply a patch, and query a snapshot. To save that snapshot and read it back:

```rust
let saved = grid.snapshot().to_bytes();
let restored = latkit::Data::read(&saved, latkit::Reading::default()).await?;
```

Use `Reading` to override the dataset name, set the base path for file slices, or supply a
`resource::Fetch`. A rendering `Host` also implements `Fetch`.

## Share an existing device

```rust
let gpu = latkit::Gpu::from_wgpu(device.clone(), queue.clone())?;
let events = gpu.device_events();
let loss = events.clone();
device.set_device_lost_callback(move |_, _| loss.lost());
device.on_uncaptured_error(std::sync::Arc::new(move |error| events.error(&error)));
```

`from_wgpu` checks device limits. Register both callbacks to forward errors to latkit.
Clone the `Gpu` to share caches and a memory budget across views. After device loss, call
`view.move_to(&gpu)` with a new GPU for each view to resume rendering with its state intact.
