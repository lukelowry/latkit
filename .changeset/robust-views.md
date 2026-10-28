---
'latkit': patch
---

Views place their camera once positions settle, draw the nearest mark where depth varies, and stop cleanly after an internal error.

- Added: where depth varies (a tilted camera, the globe, or raised vertices on a plane or the earth), points and strokes write their depth before any color draws, so the nearest mark shows whatever order it draws in. A marker's depth is its radius toward the camera, so an edge meeting a vertex ends inside it. Flat views draw in order as before.
- Added: `theme.gridSpacing`, the least distance in CSS pixels between the lines of a plane's or diagram's grid and of the earth's graticule. Defaults to 24. Steps are 1, 2, and 5 times a power of ten (30° and 90° past 10° on the earth), chosen per axis.
- Added: theme and expression colors take `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, and `oklch()`, clipped to sRGB.
- Added: a legend shows a colormap that fits its values, across the fitted domain, and a categorical colormap's cells without names.
- Added: in a diagram, a label wider than its block, or a group's title wider than its box, ends in "…".
- Added: a net with one port draws a stub out from it.
- Added: the `stopped` error code. After an internal error, every view reports it once, every `Gpu` is lost, later calls throw it, and `destroy()` still works.
- Changed: a fit applies once positions settle in every space (data streamed, shapes triangulated, layouts placed, vertices eased), and frames show only the background until the first fit applies, so the first frame drawn shows what it framed.
- Changed: a fit with nothing to frame waits without asking for frames and frames the rows that arrive later. A newer fit replaces one being measured.
- Changed: the first fit of any kind, not only `fit('all')`, bounds how far the camera zooms and pans. After a fit of a small box, the camera can still pan half a view.
- Changed: a fit frames a diagram at most at its natural size (zoom 0) and the earth at most at zoom 16, where it also frames a single point.
- Changed: a canvas with no box, such as one under `display: none`, draws no frames, so its views derive and fit nothing until it is shown.
- Changed: a field holding only missing values fits any kind. Its first values set its kind, a reference takes its table's id kind, and missing values write to a field of any kind. Number ids for a table with text ids are an error.
- Changed: a colormap or scale over a domain of one value maps to its middle, and a reversed domain maps in reverse.
- Changed: on the earth, `elevation` and a camera's elevation are in degrees of arc, like every other length there.
- Changed: `contains` is a list of `[table, reference]` pairs, so a group can hold rows of several tables: `contains: [['Machine', 'unit'], ['Exciter', 'unit']]`.
- Changed: each row of a diagram is one block however many vertex marks draw it. Its size is the largest any of them gives, and its ports are those of all of them, one per reference field.
- Changed: Tab steps to the row nearest the middle once, and the next Tab or Shift+Tab leaves the view.
- Changed: Shift+F10, the menu key, and screen readers ask for a menu through the page's `contextmenu`. On Apple platforms, a Control-click is a secondary click.
- Changed: `\n` in a label starts a new line in the browser.
- Changed: a one-row edit of a label's text starts no transition, so only its page evaluates, and outside diagrams it lays nothing out again.
- Changed: a scene with fewer marks, shown while label texts are being read back, no longer panics.
