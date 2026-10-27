---
'latkit': minor
---

The command line plays an axis span.

- Added: `--span FROM,TO` and `--rate`. A video or image sequence without `--frames` plays the datasets' span.
- Added: with `--span`, each `--frames` line applies at its `at`, and the camera flies between lines that set it.
- Added: `view.fly(camera, seconds)`.
- Changed: setting or flying the camera replaces a pending fit.
