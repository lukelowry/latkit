# 70,000-bus fault — Python + latkit CLI

[Watch the animation](animation.mp4) · [Preview](preview.png)

The saved ACTIVSg70k recording: simulation 0.6–1.4 s at 0.1×, then 1.4–10 s at 1×, 997 frames at
60 fps and 1920 × 1080. The fault is on bus 56923 at 1 s and clears at 1.15 s. Every bus keeps its
frequency-dependent color and signed height; a plot below traces six buses with a playhead.

[`render.py`](render.py) uses only Python's standard library. It writes the grid and the traced
buses as latkit JSON, whose frame columns are slices of the saved float32 caches, and a frame per
output frame that appends them. latkit reads the states' GeoJSON, draws the map with its title and
legend over the plot, and encodes the MP4: 5.5 s for the 997 frames on an RTX 2080 SUPER.

```sh
python crates/latkit-cli/examples/bus-fault/render.py <outputs> --cli target/cli/latkit --preview
python crates/latkit-cli/examples/bus-fault/render.py <outputs> --cli target/cli/latkit
```

`<outputs>` is the recording's directory: `buses.json`, `topology.json`, `usa-states.geojson`,
`depth-metadata.json`, and the frame-major caches `depth-frequency.f32` and `depth-height.f32` in
the metadata's bus order. They are not in this repository. Frequency comes from a causal 20 ms
filtered derivative of bus voltage angle; height is `asinh(df / 0.02) / asinh(0.35 / 0.02)`; colors
clip to ±0.05 Hz.

The recipe writes its JSON to `target/bus-fault/` and keeps existing scenes and cameras there, so
edits survive a rerun. `--prepare-only` prints the command without rendering; `--limit N` renders the
first N frames. `animation.json` and `preview.json` record the command and timings.
