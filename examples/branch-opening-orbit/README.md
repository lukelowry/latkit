# Line-opening orbit

[Watch the video](animation.mp4) · [Preview](preview.png)

A close 108° orbit around the network, starting farther toward the East Coast
and stopping before the far-western viewpoint. Magnification stays nearly
constant, with a higher viewing angle throughout and no late pullback or dip.
Centering and rotation change smoothly along the shorter arc.

The saved simulation and visual scales come from the [original example](../branch-opening/README.md):
70,000 buses, the Little Rock–Newark 765 kV line opening at 1 s, 0.4× playback,
reduced height, no plot, 1920 × 1080 at 60 fps. The video is 23.517 seconds (1,411 frames).
The original example and its video remain separate.

## Reproduce

Run from the repository root with the saved study in `target/branch-opening/`:

```powershell
python examples/branch-opening-orbit/render.py --cli target/cli/latkit.exe --preview
python examples/branch-opening-orbit/render.py --cli target/cli/latkit.exe
```

Python prepares the documents; Latkit draws and encodes the video. The shared
[data recipe](../branch-opening/render.py) and state boundaries are read from the
original example. Generated inputs go into `target/branch-opening-orbit/`.
No simulation rerun, duplicated frequency recording, or full image sequence is needed.

Edit [camera.json](camera.json) to change the orbit.
`at` is simulation time in seconds, `center` is longitude/latitude,
`scale` is the plane's pixels per coordinate unit, and `pitch`/`bearing` are degrees.
The recipe writes native CLI `camera` values into every frame. Monotone cubic Hermite
interpolation gives continuous camera velocity without overshooting keyframes;
zoom interpolates in logarithmic space, with gentle starts and stops.

`--preview --at 5.8` shows the matching camera at that simulation time. `--prepare-only`
writes the inputs and prints the complete CLI command. `--source`, `--work`, `--output`,
and `--limit` support alternate data, scratch directories, and short previews.
Each output's JSON records its camera path, source checksum, timing, and render command.

Frequency and height retain the original example's interpretation: a filtered
voltage-angle frequency estimate and an exaggerated, nonlinear height encoding.
Close framing favors the network and response over peripheral state boundaries.

The delivered video was decoded end to end (1,411 frames), with sample
brackets checked at every frame and framing inspected around the opening and
along the camera path.
