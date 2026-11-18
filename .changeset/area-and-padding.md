---
'latkit': minor
---

A page can read where a view's marks draw, and set the room between the view's edge and its guides.

- Added: `view.area`, where marks draw as `[x, y, width, height]` in CSS pixels: inside the insets and the room that titles, legends, and a plot's axes take. An `area` event reports each change. A timeline or readout over a plot lines up with it, without projecting the camera.
- Added: `theme.padding`, the space between the view's edge, inside its insets, and the guides beside it, in CSS pixels. Defaults to 1.5 times the text size, as before.
