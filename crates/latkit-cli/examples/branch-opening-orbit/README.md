# Line-opening orbit

[Preview](preview.png) · The video is not in Git: [reproduce it](#reproduce) to write
`animation.mp4` here.

A close orbit around the network: the bearing turns 108°, from −70° to +38°, while the center
drifts west from 84.5° W to 87° W at 37.5° N. Zoom stays nearly constant and pitch stays between
46° and 50°, so the view never pulls back or dips. Center and bearing change smoothly between
keyframes.

The saved simulation and visual scales come from the [original example](../branch-opening/README.md):
70,000 buses, the Little Rock–Newark 765 kV line opening at 1 s, 0.4× playback,
reduced height, no plot, 1920 × 1080 at 60 fps. The video is 23.517 seconds (1,411 frames).
Rendering the orbit leaves the original example and its video untouched.

## Reproduce

Run from the repository root with the saved study in `target/branch-opening/`:

```powershell
python crates/latkit-cli/examples/branch-opening-orbit/render.py --cli target/cli/latkit.exe --preview
python crates/latkit-cli/examples/branch-opening-orbit/render.py --cli target/cli/latkit.exe
```

Python writes the CLI inputs; the latkit CLI draws and encodes the video. The
[data recipe](../branch-opening/render.py) and state boundaries come from the
original example. Generated inputs go to `target/branch-opening-orbit/`.
Nothing is simulated again, the frequency recording is not copied, and no image sequence is written.

Edit [camera.json](camera.json) to change the orbit.
`at` is simulation time in seconds, `center` is longitude/latitude,
`scale` is the plane's pixels per coordinate unit, and `pitch`/`bearing` are degrees.
The recipe writes a `camera` value into every line of the CLI's frames file. Keyframes are
interpolated with monotone cubic Hermite splines, so camera velocity is continuous, no value
overshoots a keyframe, and the path starts and stops gently. Zoom is interpolated in log space.

`--preview --at 5.8` renders the frame at that simulation time, with its camera. `--prepare-only`
writes the inputs and prints the complete CLI command. `--source`, `--work`, and `--output` choose
other data, scratch, and output directories; `--limit N` renders only the first N frames.
Each output's JSON records its camera path, source checksum, timing, and render command.

Frequency and height mean the same as in the original example: frequency is estimated from
filtered voltage angles, and height exaggerates it on a nonlinear scale. The close framing shows
the network's response rather than the outer state boundaries.

The delivered video was decoded end to end (1,411 frames). The samples bracketing each frame's time
were checked at every frame, and the framing was inspected around the opening and along the camera
path.
