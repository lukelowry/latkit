# ACTIVSg70k line opening — Python + latkit CLI

[Preview](preview.png) · The video is not in Git: [render the saved study](#render-the-saved-study)
to write `animation.mp4` here.

The synthetic 70,000-bus network responds as the Little Rock–Newark 765 kV line
(`branch_59757_59774_1`) opens at 1 s and stays open. The video shows simulation time
0.6–10 s at a constant 0.4× speed: **1,411 frames, 60 fps, 1920 × 1080,
23.517 seconds**. The map fills the frame, and a dashed gold line marks the open
branch. The camera's bearing sweeps 30° to show the response from changing angles.

[`render.py`](render.py) uses only Python's standard library and the latkit CLI. latkit
draws the network, state boundaries, labels, and frequency legend, and encodes H.264
with its native Windows MP4 output. The recipe needs no Rust code, browser, Python
imaging library, or external encoder.

## Render the saved study

From the repository root, with Python 3.10+ and the saved study present:

```powershell
cargo build --locked -p latkit-cli --profile cli
python crates/latkit-cli/examples/branch-opening/render.py --cli target/cli/latkit.exe --preview
python crates/latkit-cli/examples/branch-opening/render.py --cli target/cli/latkit.exe
```

An installed CLI works too: `python crates/latkit-cli/examples/branch-opening/render.py`.
Use `--preview --at 2.5` for a still at another time, `--limit 120 --output target/preview`
for a short movie, or `--prepare-only` to write the inputs and print the complete
CLI command. The scene and camera JSON are written to `target/branch-opening/render/`;
to experiment with the view, edit them and run the printed CLI command directly.
Rerunning the recipe overwrites them.

The optional positional argument selects another saved-study directory, which holds:

```text
target/branch-opening/
  buses.json
  topology.json
  runs/little-rock-60hz/
    frequency_metadata.json
    frequency.f32
```

The recording is local data, **not included in Git**. The small state-boundary file,
`states.geojson`, comes from the bus-fault recording and is included here.
`animation.json` and `preview.json` record the command, source checksum, scales,
dimensions, and render timing. Native MP4 output currently requires Windows.

## Data and display

The study used `ghcr.io/lukelowry/gridkit:develop-perf`, image ID
`sha256:befba9e16edce341888e73c05b9d2c35aedf1357fa18b54c56114dbe25ccd565`,
and the original ACTIVSg70k case, SHA-256
`8c3d1edd9deaf409436b1f38e55f41c963d08eae7709474bcfb2c1dffadbdb15`.
The full simulation manifest is stored beside the recording.

Only bus voltage angles were monitored, at 60 Hz over 0–10 s, with both sides of
the event retained. Frequency is the causal 20 ms filtered derivative of unwrapped
voltage angle, expressed as Hz deviation from 60 Hz. The raw angles were streamed
and discarded. This is a bus voltage-frequency estimate, not generator rotor speed.
The switching angle jump produces a brief impulse (about −1.647 to +0.683 Hz).

Colors saturate at ±0.20 Hz. Signed height is exaggerated by
`height_scale * asinh(df / 0.02) / asinh(0.35 / 0.02)`; it is a visual encoding of
frequency, not physical displacement. `height_scale` includes a gain of 0.45, which
scales every height down by 55% while keeping its sign and nonlinear shape. The
camera keeps a fixed center, zoom, and 48° pitch, with bearing easing from −10° to
+20° over the full recording. This keeps the initial peak in view and makes the
geography easier to follow. There is no bottom plot or trace legend.

`HEIGHT_GAIN` and `BEARINGS` near the top of `render.py` control the exaggeration
and camera sweep. The camera path follows simulation time, so a preview at any time
matches that moment in the movie.

For slow motion, latkit interpolates between the recorded samples and computes the
height expression on the GPU. The recipe appends only the samples the next picture
needs and forgets older ones. It selects samples with the same comparison latkit uses:
the lower sample must be **at or before** the requested time. The samples on either
side of the event stay distinct, so no picture before the opening shows data from after it.
The recipe writes no interpolated or height cache and no image sequence.

The CLI validates the generated documents before rendering. The delivered MP4 was
also decoded end to end and checked around the event and sample boundaries.
