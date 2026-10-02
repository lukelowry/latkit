---
'@latkit/model': minor
'@latkit/gpu': patch
---

Add `locateSample` for consistent observation lookup. Reuse local query, field, and scale results by
immutable sample dependencies rather than exact playhead coordinates or whole data publications.
Playback benefits automatically through existing view APIs, including after sample appends.
