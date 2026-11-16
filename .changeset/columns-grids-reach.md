---
'latkit': minor
---

Traces draw exact to the pixel, grids hold still, the camera's limits are an option, and tiles stay fetched.

- Added: `controls.reach`, how far the camera may go from what fits framed: `"fit"`, `"space"`, or `{ zoomOut, zoomIn, pan }`. `Reach` in Rust.
- Added: `tiles.describe()` resolves to what a tile source says of itself: its `attribution`, `zooms`, `bounds`, and `layers` with their fields. `Tiles::describe` in Rust.
- Added: `budget.tiles`, the memory for the tiles fetched from every `Tiles` source. Defaults to 256 MiB.
- Added: `theme.grid.width`, the width of a grid line.
- Changed: a trace with more than two frames per pixel column draws each column's least and greatest value, two points a column, read from entries no wider than a column. Before, it drew buckets up to four pixels wide, which showed as steps.
- Changed: buckets wider than a pixel column, which stand in while finer ones load or when the budget allows no finer, draw as a line through their least values and one through their greatest. Before, they drew as bars.
- Changed: a trace's budget counts the entries it holds, and the same number bounds what time tiles fetch, so a trace fetches the level it draws. The 64-span limit is gone.
- Changed: hovering a trace reports the least or greatest sample of the column under the pointer.
- Changed: a grid's lines lie at steps the camera's zoom alone picks. Turning or tilting the view moves and fades none, and lines run on to the horizon.
- Changed: a fit no longer stops the zoom 8 levels in from what it framed. Set `controls: { reach: { zoomIn: 8 } }` to keep that.
- Changed: a GPU keeps what it fetched and decoded of a tile source while its `Tiles` lives. Before, it dropped a source when the last view stopped drawing it.
- Changed: a column written whole costs its pages, not its rows, in a table drawn in pages. At a million rows, a frame that wrote one took 9 ms on the CPU for points and 30 ms for a grid's buses. It now takes 1 and 4.
- Changed: `earth.graticule` is now `earth.grid`, and takes what a plane's `grid` takes: `"off"`, `"lines"`, `"dots"`, or `{ lines | dots: { step } }`.
- Changed: a grid's `pitch` is now `step`, the finest distance between its lines.
- Changed: `theme.grid` is now `{ color, width, spacing }`. `theme.gridSpacing` is now `theme.grid.spacing`.
- Fixed: areas on the globe showed the ground through them toward its edge.
