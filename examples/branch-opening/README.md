# ACTIVSg70k line opening — Python + Latkit CLI

[Watch the video](animation.mp4) · [Preview](preview.png)

The synthetic 70,000-bus network responds to the Little Rock–Newark 765 kV line
(`branch_59757_59774_1`) opening at 1 s. It stays open. The video shows simulation
0.6–10 s at a constant 0.4× speed: **1,411 frames, 60 fps, 1920 × 1080,
23.517 seconds**. The map fills the frame, and a dashed gold line marks the disconnected
branch. A gentle 30° camera sweep reveals the response from changing angles.

[`render.py`](render.py) uses Python's standard library and the Latkit CLI. Latkit
draws the network, state boundaries, labels, and frequency legend, and encodes H.264
through its native Windows MP4 output. There is no Rust consumer, browser renderer,
Python imaging dependency, or external encoder in this recipe.

## Render the saved study

From the repository root, with Python 3.10+ and the saved study present:

```powershell
cargo build --locked -p latkit-cli --profile cli
python examples/branch-opening/render.py --cli target/cli/latkit.exe --preview
python examples/branch-opening/render.py --cli target/cli/latkit.exe
```

An installed CLI works too: `python examples/branch-opening/render.py`.
Use `--preview --at 2.5` for a different still, `--limit 120 --output target/preview`
for a short movie, or `--prepare-only` to write the inputs and print the complete
CLI command. Scene and camera JSON are generated in `target/branch-opening/render/`;
edit those and run the printed CLI command directly to experiment with the view.
A recipe rerun regenerates its inputs.

The optional positional argument selects another saved-study directory. Its files are:

```text
target/branch-opening/
  buses.json
  topology.json
  runs/little-rock-60hz/
    frequency_metadata.json
    frequency.f32
```

The recording is local, ignored data; it is **not included in Git**. The small state
boundary asset is reused from the earlier bus-fault recording and included here.
`animation.json` and `preview.json` record the command, source checksum, scales,
dimensions, and render timing. Native MP4 output currently requires Windows.

## Data and display

The study used `ghcr.io/lukelowry/gridkit:develop-perf`, image ID
`sha256:befba9e16edce341888e73c05b9d2c35aedf1357fa18b54c56114dbe25ccd565`,
and the original ACTIVSg70k case from GridKit Studio, SHA-256
`8c3d1edd9deaf409436b1f38e55f41c963d08eae7709474bcfb2c1dffadbdb15`.
The full simulation manifest remains beside the recording.

Only bus voltage angles were monitored, at 60 Hz over 0–10 s, with both sides of
the event retained. Frequency is the causal 20 ms filtered derivative of unwrapped
voltage angle, expressed as Hz deviation from 60 Hz. The raw angles were streamed
and discarded. This is a bus voltage-frequency estimate, not generator rotor speed.
The switching angle jump produces a brief impulse (about −1.647 to +0.683 Hz).

Colors saturate at ±0.20 Hz. Signed height is exaggerated by
`height_scale * asinh(df / 0.02) / asinh(0.35 / 0.02)`; it is a visual encoding of
frequency, not physical displacement. The height gain is 0.45 of the earlier view,
reducing displacement by 55% while preserving its sign and nonlinear scale. The
camera keeps a fixed center, zoom, and 48° pitch, with bearing easing from −10° to
+20° over the full recording. This keeps the initial peak in view and makes the
geography easier to follow. There is no bottom plot or trace legend.

`HEIGHT_GAIN` and `BEARINGS` near the top of `render.py` control the exaggeration
and camera sweep. The camera path uses simulation time, so an arbitrary preview
matches that moment in the movie.

For slow motion, Latkit interpolates between the original samples and computes the
height expression on the GPU. The recipe appends only samples needed for the next
picture and forgets older ones. Its timestamp comparison exactly matches Latkit's:
the retained lower sample must be **at or before** the requested time. Both event
sides remain distinct, so post-opening data never leaks into pre-opening pictures.
No dense interpolated cache, height cache, or full image sequence is written.

The CLI validates the generated documents before rendering. The delivered MP4 was
also decoded end to end and checked around the event and sample boundaries.
