---
'latkit': patch
---

Looking straight down, elevation only decides which rows show on top, and rows rise into view as the camera tilts.

- Changed: looking straight down, each row draws over its ground position, and elevation only sets its depth, so a higher row hides a lower one across every mark with no perspective shift. Lines between rows at one place, such as poles, shrink to a point under them. Over the first 10° of tilt, rows rise smoothly to where they stand.
- Changed: panning, turning, and zooming keep a raised row under the pointer while rows rise into view, and positions under the pointer and drags read where the row draws.
