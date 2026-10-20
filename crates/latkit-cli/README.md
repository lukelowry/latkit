# latkit CLI

Draws latkit scenes of datasets into images, image sequences, raw frames, and videos, on the
machine's GPU, with the same renderer as the browser package. Inputs are latkit's JSON, so any
language can write them. The package is `latkit-cli`; the executable is `latkit`.

```sh
cargo install latkit-cli
latkit validate scene.json -d grid.json
latkit render scene.json -d grid.json -o grid.png --size 2400x1350 --scale 2
latkit render scene.json -d grid.json --frames frames.jsonl --fps 60 -o film.mp4
latkit query grid.bin '{"of":"Branch","filter":{"op":"gt","args":["loading",90]},"limit":20}'
latkit schema scene > scene.schema.json
```

Commands, inputs, frames, outputs, and diagnostics are in
[the documentation](https://latkit.readthedocs.io/en/latest/cli.html).
[The gallery](examples/cli-gallery/README.md) and [the 70,000-bus fault](examples/bus-fault/README.md)
are made with Python and this CLI alone.
