# WECC240 fault with GridKit and the latkit CLI

[Preview](preview.png) · The video is not in Git: [reproduce it](#reproduce) to write
`animation.mp4` here.

The reference WECC240 fault is applied at **John Day, bus 4005**, at 1.00 s and cleared at 1.15 s,
with fault impedance R = 0, X = 0.01 p.u. The model has 243 buses, 447 branches, 103 synchronous
machines, and 37 inverter groups. GridKit simulates 0–10 s, and latkit renders
**1920 × 1080, 60 fps, 1,561 frames** into a 26.017-second H.264 MP4. Playback slows to 0.1× around
the fault and runs at 0.5× elsewhere.

The preview, case, compact recordings, and reproduction scripts are in Git. Intermediate CSV files
and generated CLI inputs stay in `target/`.

## Reproduce

From the repository root, with Python 3.10+, Docker, and the image available locally:

```powershell
python crates/latkit-cli/examples/wecc240-fault/simulate.py
cargo build --locked -p latkit-cli --profile cli
python crates/latkit-cli/examples/wecc240-fault/render.py --preview
python crates/latkit-cli/examples/wecc240-fault/render.py
```

Skip the first command to render the included recording without Docker. `render.py` uses
`target/cli/latkit.exe` (or `target/cli/latkit`) if present, and otherwise an installed `latkit`.
Use `--cli PATH` to select another executable, `--preview --at 1.12` for a still, or
`--limit 120 --output target/wecc-preview` for a short movie. `--prepare-only` writes the scene,
data, camera, and frame inputs under `target/wecc240-fault/render/` and prints the CLI command.
Native MP4 encoding requires Windows. The Python recipes use only the standard library. The state
boundaries come from [`../branch-opening/states.geojson`](../branch-opening/states.geojson).

## Simulation and display

The run used `ghcr.io/lukelowry/gridkit:develop-perf`, pinned for execution to:

```text
sha256:befba9e16edce341888e73c05b9d2c35aedf1357fa18b54c56114dbe25ccd565
```

`simulate.py` resolves the requested tag to its local image ID before running, and runs it with two
CPUs and networking disabled. To reproduce with this exact image, pass that ID with `--image`. The
saved [metadata](recording/metadata.json) includes the image labels, case hashes, solver settings,
sample times, and recording hashes.

Monitors sample at 240 Hz and keep both sides of the fault's application and clearing, 2,403
samples in total. The map shows bus frequency deviation, estimated with a 20 ms causal filtered
derivative of unwrapped voltage angle. The angle jumps at switching cause brief impulses. Colors
saturate at ±0.1 Hz. Height exaggerates the same quantity on an `asinh` scale. It is a visual
encoding, not a physical displacement.

The upper plot shows actual GENROU rotor-speed deviation (`omega × 60 Hz`) for 4039_G, the machine
with the largest absolute excursion. The lower plot shows faulted-bus voltage. A white playhead
follows simulation time. These are distinct measurements: estimated bus frequency, rotor speed, and
voltage.

The runtime case differs from the source case only in its monitors and their names. GridKit reports
initialization adjustments to small Hygov time constants and Repca reactive limits. The complete
messages are in [solver.txt](solver.txt). `animation.json` and `preview.json` record render
settings, timing, and hashes.

## Source

`source.case.json` comes from GridKit's `cases/PhasorDynamics/WECC240/WECC240.case.json`, with only
line endings normalized to LF. Fault parameters match its
`examples/PhasorDynamics/Validation/WECC240/WECC240.solver.json`. The upstream case README credits
the National Laboratory of the Rockies test case repository. The GridKit notice is retained in
[SOURCE-LICENSE.txt](SOURCE-LICENSE.txt).

This product includes software produced by UT-Battelle, LLC under Contract
No. DE-AC05-00OR22725 with the Department of Energy.
