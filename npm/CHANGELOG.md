# latkit

## 0.12.0

### Minor Changes

- f397d72: Comets keep their spacing on screen, cost little while only they move, rest while the camera moves, and keep clear of arrowheads.

  - Fixed: comets and dashes in CSS pixels bunched on fanned edges and spread out on north–south edges away from the equator. They keep the theme's spacing on screen along every path, through fans, on a flat map, a tilted one, and the globe.
  - Fixed: comets covered the arrowheads of short or bent edges. They fade out before the head, and a stub too short for one carries none.
  - Changed: comets move without a pass over their rows each frame.
  - Changed: comets draw on their own, after their strokes, and only around each comet, so their cost follows the comets on screen rather than the length of the strokes they ride.
  - Changed: while the camera moves by a gesture, a flight, a fit, or a camera set from code, comets fade out and hold still, and they fade back in once it rests for 0.15 s. Orbits, pictures, videos, and reduced motion keep them moving.
  - Changed: a comet with less than 3:1 contrast to its stroke takes a 1-pixel rim of the background color.
  - Added: `controls.fps` (Rust: `Controls::fps`), the most frames a second a canvas draws while only endless motion moves: comets, an orbit, or options that read `elapsed()`. Defaults to 60.

- f397d72: Frames draw only the marks that change, and rows whose heights change every frame stay smooth.

  - Changed: in a run of frames where only some marks change, as a shade reading the time or a layer of streaming rows does, or where only comets move, each frame starts from a kept image of the marks before the first that changed and draws only the rest. A lone such frame between changes draws whole.
  - Changed: under `daylight`, the sun moves in steps of 4 seconds of the view's axis, too small to see, so a view playing through time keeps its kept image for a step rather than drawing every mark each frame.
  - Changed: where heights change every frame, as a sampled field raising rows during playback, the sort that draws raised rows nearest last spreads over frames under a fixed budget, and frames draw in the last finished order meanwhile. A small table still sorts every frame. A change after heights rested sorts at once, and once they rest, the sort under way finishes in that frame.

- f397d72: A label too large for its marker shows beside it, text inside a shape or block reads on its color, and no label shows under a legend.

  - Fixed: a label on a block, or on a marker with a width and height, vanished when its text did not fit inside. It now shows beside the marker and competes for room like a point's label.
  - Changed: text inside a shape or block keeps a 4.5:1 contrast with the row's color, lighter or darker as it needs, and its halo is that color.
  - Fixed: where markers holding labels overlapped, every label inside them showed, over each other and over the markers drawn above. A label inside a marker now takes the marker's room, so only the top one's label shows.
  - Fixed: labels showed over a title or legend in a corner. A corner's guides now take their room from labels, so none shows under them.

- f397d72: A recording plays along as its frames arrive, and keeps on the GPU and in memory only the frames it holds.

  - Added: `playhead.live` (Rust: `Playhead::set_live`). The playhead plays along the end of its span as the page extends it with arriving data, trailing the end at the rate the end moves, so data that arrives in uneven chunks plays at an even pace. It eases to a stop when no more arrives.
  - Fixed: frames a dataset forgot stayed cached on the GPU until the page pool reached its budget, 1 GiB by default. They are now freed, so a recording keeps only what it holds.
  - Fixed: after `forget`, up to 16 pages of each row block and level of detail stayed in memory per sampled field, so a rolling window of a large recording grew memory far past the frames it kept. Forgotten frames are now freed once no version reads them.
  - Changed: a table drawn in priority order or by tiles reads sampled fields on the GPU through its rows, as any other table does. Showing another frame no longer gathers each row's value on the CPU, which took about 40 ms a frame for 165,000 rows.
  - Changed: appending frames opens each page of a row block's frames at its full size, so it fills without moving.
  - Fixed: after `forget`, `describe().span` could start a coarse bucket before the first frame kept, and move back as buckets filled. It now starts at the first frame kept.
  - Fixed: a time tiles index not there yet, as before a recording's first frames, failed as "not TileJSON". It now fails as not found, and is fetched again after its retry.
  - Fixed: Chrome warned "READ-usage buffer was written, then fenced, but written again before being read back" while labels settled or the pointer moved. A readback buffer now gets new storage at its next write rather than after each read, which also spares the browser a copy of it.

- f397d72: Frames place each segment of a path once, a hover draws only the rows it lights, and thin lines stay solid.

  - Changed: each frame works out where every segment of the edges and lines it draws lies on screen once, before drawing, and the opaque, rows, comets, and lit draws of a mark all read that, rather than each corner of each draw working it out again. A trace's segment and a point cost less to place than to store, so their draws place them. On an integrated GPU, a plot of 2,000 traces takes 39 ms of GPU time a frame rather than 50 ms.
  - Changed: in a browser, a render pass reuses the WebGL framebuffer that holds its targets rather than making one.
  - Changed: hovering a row no longer draws every mark again. The frame starts from the kept image of the marks, and only the hovered row and the rows it lights draw over it. On a grid of 900,000 lines and buses on an integrated GPU, a hover takes one frame of about 3 ms of GPU time, rather than frames of 36 ms and 18 ms.
  - Changed: a hovered marker grows under its label rather than pushing the label outward, so a hover lays out no labels.
  - Changed: on a globe, a frame that starts from the kept image of the marks draws only the globe's depth under it, not the whole backdrop again.
  - Changed: in a browser, latkit checks for WebGL errors once the GPU has caught up with the work given it, so the check answers at once rather than holding the page behind the next frame. While frames keep the GPU busy, it waits at most a second. Waits on the GPU poll every task for their first 3 ms, then back off to every 4 ms, rather than polling every task for as long as they wait.
  - Changed: appending frames to a sampled field folds each frame into the levels of detail as it goes, so sealing a bucket no longer reads its frames again. On a 165,000-row field, appends no longer take 20 to 35 ms on every 8th and 64th frame.
  - Fixed: hovering or selecting a row threw away the kept image of the marks, a texture the size of the canvas, and made it again the frame after. Its texture now stays through such frames, and goes after 120 frames in a row without it.
  - Fixed: lines thinner than a screen pixel, such as 1 px traces at a browser zoom of 50%, looked dotted along diagonals. They now draw a pixel wide, as bright as their width's share of it.

### Patch Changes

- f397d72: Views show only their own pixels, and arrowheads point somewhere.

  - Fixed: where the browser gave the shared canvas a smaller drawing buffer than it asked for, as Chrome does on large high-density screens, the bottom rows of each view showed another view's pixels. The shared canvas now starts at the screen's size rather than the next power of two, and takes the size of the buffer it gets.
  - Fixed: an arrowhead on an edge between two vertices at one place drew as a translucent square around them. An edge with no length on screen now has no head.

- f397d72: A live monitor no longer pauses for reads of GPU results or for memory, and takes in its frames faster.

  - Changed: in a browser, while a read of GPU results waits and the GPU has not finished the frame shown last, canvases hold the next frame, so the read does not wait behind a frame given the GPU after it.
  - Changed: appending frames to a sampled field reads `f32` values as they are stored, and converts other values once per append rather than one at a time. Appends take about a third less time.
  - Fixed: a recording whose memory keeps growing paused for 100 to 250 ms whenever its row blocks opened new pages together, as each page grew the WebAssembly memory on its own. Appends make room for those pages at once, and once the memory holds 64 MB or more, latkit keeps an eighth of it free ahead.

## 0.11.0

### Minor Changes

- 590f95e: A page can read where a view's marks draw, and set the room between the view's edge and its guides.

  - Added: `view.area`, where marks draw as `[x, y, width, height]` in CSS pixels: inside the insets and the room that titles, legends, and a plot's axes take. An `area` event reports each change. A timeline or readout over a plot lines up with it, without projecting the camera.
  - Added: `theme.padding`, the space between the view's edge, inside its insets, and the guides beside it, in CSS pixels. Defaults to 1.5 times the text size, as before.

- 590f95e: Edges joining the same two vertices run side by side, a few pixels apart at any zoom, instead of bowing apart. The theme sets their spacing and how they meet their vertices.

  - Added: `theme.edge.parallel`, with `gap`, the space between neighboring edges in CSS pixels (defaults to 3), and `converge`, how they meet the vertices they join: `squeeze` (the default) draws them closer so the family fits within the smaller vertex, `fan` keeps their spacing and angles them in to each vertex's center, and `straight` keeps their spacing and stops each at its vertex's outline, or beside it. `null` draws them over one another. Rust: `EdgeTheme::parallel`, `Parallel`, and `Converge`.
  - Removed: `theme.edge.bow`. Use `parallel`, or `parallel: null` where `bow` was 0.
  - Changed: parallel edges are each moved sideways on screen by a step, an edge's width plus `gap`, so they look the same on a plane, tilted, and on the globe, and stay apart when zoomed out. Edges that bend through the same points, and edges along great circles, now run side by side too. More than eight edges pack within eight steps, and edges less than a pixel apart draw only every second one, or fewer.
  - Changed: a straight edge with parallel neighbors draws as one segment instead of sixteen, or three where it fans. Only fans and great circles need a segment list, and moving the camera never rebuilds it.

- 590f95e: Views can follow a `Playhead`, which plays the axis coordinate they show without the page setting `at` every frame.

  - Added: `Playhead`, an axis coordinate that moves at a rate while it plays, within an optional span that it stops at or loops around. Views that follow one show the same coordinate in the same frame. A frame moves it at most a quarter second's worth, so a page that stalls or is hidden resumes where it was.
  - Added: `view.playhead` and the `playhead` option of `View.create`. Scrubbing a view that follows a playhead moves the playhead, and setting the view's `at` does too.
  - Added: in Rust, `web::Playhead` and `PageView::follow`.

- 590f95e: A history can be written as time tiles while it is recorded, with the levels of detail latkit builds, in memory that stays the same however long it grows.

  - Added: `TileWriter`, which applies patches of appends to the tables of a base dataset and writes each span as it fills. `flush` writes the spans in progress, the base, and `frames.json`, so `Tiles` drawing them find every frame so far. Its files are the ones `latkit tile` writes for the same frames.
  - Added: in Rust, `TileWriter`.

### Patch Changes

- 590f95e: A canvas shows its views' backgrounds from the moment it is made, never black, and keeps its last frame when the GPU is lost.

  - Fixed: a canvas showed black until its views' shaders compiled, about half a second on a large scene. It now shows each view's background from the same task that makes it, as frames show until a fit places the camera. Resizing it before its first frame shows the backdrop too.
  - Fixed: on a canvas with several views, a view that had not drawn yet showed black in its panel. It shows its background until it draws.
  - Fixed: gaps between a canvas's panels showed black, or what an earlier layout drew there. They show the first view's background, as gaps in a picture do.
  - Fixed: after the GPU was lost, a canvas started over while its views compiled again. It keeps its last frame, its focus, and the pointers it holds.
  - Fixed: while its views' shaders compiled, a new canvas asked for a frame on every animation frame. It now waits for each compile to land.
  - Added: in Rust, `Canvas::move_to`, which moves a canvas to a new `Gpu` as `PageView::move_to` moves a view.

- 590f95e: Setting a view's scene or camera to what it already has changes nothing, so a page no longer needs to compare scenes before it sets them.

  - Changed: setting `view.scene` to an equal scene no longer swaps scenes, emits a `waiting` event, or draws a frame.
  - Changed: setting `view.camera` to the camera already placed, while no flight or fit moves it, no longer cancels anything. A plot camera with `y: null` keeps fitting its values as before.
  - Changed: a setter that changes nothing draws no frame. Before, every setter drew one.

- 590f95e: Labels finish in browsers on Windows: a view with more labels than it sets in one frame no longer waits on `labels` forever, drawing every frame.

  - Fixed: on Direct3D, which Chrome and Edge use on Windows, the pass that lists the texts labels need misread which texts were set once a view took more than one frame to set them, as with more than 48 labels in view or a font that rasterizes slowly. The view kept asking for the same texts, some labels never showed theirs, and `waiting` stayed `['labels']`.
  - Changed: a label text asked for again after it was set no longer counts as progress. The view finishes, and the mark lists a failure saying some labels show no text.
  - Changed: building latkit fails if a shader indexes a swizzle by a runtime value, which Direct3D reads wrong.

- 590f95e: A path draws as one stroke: curved edges and other paths of several pieces no longer show a bead where two pieces meet.

  - Fixed: both pieces of a path drew the pixels around the point where they met, so a translucent stroke darkened there. The beads showed along edges through bends and along great circles, and on lines and traces. They showed under a hover or selection glow, on rows a selection dims, on translucent colors, and faintly along thin strokes, whose antialiased edges are translucent. Comets brightened as they passed each point.
  - Changed: where a path runs on through a point, the two pieces split its pixels along the line that halves the angle between them, and each draws only its side. Their quads no longer overlap there, so a curved edge and its glow shade fewer pixels. A turn too sharp for the pieces' lengths, as at a dense trace's spikes, keeps both pieces' round ends. An arrowhead is drawn whole.

- 590f95e: Fewer stalls on the browser's GPU process, readbacks without warnings, plots that fit their traces on the CPU, and time tiles that draw their last frames at every zoom.

  - Fixed: with time tiles, a plot zoomed out far enough to draw from a coarse level left out the frames past that level's last whole bucket: up to 511 frames where it draws buckets of 512. They are now fetched from the finer levels that hold them and drawn.
  - Changed: with WebGL, latkit reads errors raised outside an error scope only while the GPU has finished everything issued, which happens between frames. Reading them waits for the browser's GPU process to finish everything issued before it, so errors read after the next frame was issued waited out that frame's GPU work: several milliseconds a frame while zooming or hovering. Where the GPU never finishes between frames, errors wait at most a second.
  - Fixed: Chrome warned that a "READ-usage buffer was written, then fenced, but written again before being read back" for every readback after the first, as when hovering. Each readback buffer now starts over once read, so the browser keeps the copy it takes for the next read.
  - Changed: a plot without a value range fits it to its traces from the samples it holds on the CPU, as the traces change or the window moves. It no longer measures them on the GPU and reads the result back a frame later. A trace whose rows' visibility comes from a field is still measured on the GPU.
  - Changed: hover and edge labels no longer read the points on either side of each segment, which only strokes need to join their segments.

- 590f95e: A tile file that fails to fetch is fetched again on its own, and an aborted fetch is no failure.

  - Changed: a file of tiles that fails to fetch (a span, a tile, a base dataset, an index, or an archive directory) is fetched again a second later, then twice as long after each further failure, at most a minute. Before, it stayed failed until `refresh()`.
  - Changed: a `fetch` option that rejects with an `AbortError` cancels the file rather than failing it. Nothing is reported, and the file is fetched again when next needed.
  - Changed: once a failed file arrives, its views stop reporting the failure.
  - Fixed: a time tiles base that failed to fetch was never fetched again, even by `refresh()`.

- 590f95e: Tiles never draw less than they did while what replaces them loads, a scene and its new tiles swap in together, a plot draws its axes with its first traces, and hovering a monitor of many traces probes only the points near the pointer.

  - Fixed: as a trace of time tiles turned coarser, such as a live history growing or a window zooming out, it dropped the spans it drew before the coarser ones landed, which showed holes, blank stretches, and blocky bands. It now draws the finer spans until the spans that replace them land, and a trace draws finer frames that hold a whole bucket before a coarser placeholder. Vector tiles keep their finer tiles the same way while zooming out.
  - Fixed: setting `view.sources` to tiles the view did not draw yet blanked the view until their first spans or tiles landed, about 100 ms. The view goes on drawing the sources and scene before until each new `Tiles` can draw, then swaps them in on one frame. A scene set between two frames swaps in with the sources set then, whichever was set first, so switching a plot to tiles under another name no longer blanks it either. A refresh that starts tiles over, as vector tiles do or time tiles whose manifest names a new base, keeps what they drew the same way.
  - Fixed: a trace that began reading a field of time tiles after only their coarsest spans loaded, as when a scene switched to them, never fetched the frames past those spans' last whole bucket.
  - Changed: a view takes a refresh of time tiles in one change, once every span it fetched again has landed, rather than one change per span.
  - Fixed: a plot drew its grid lines and axes about 400 ms after its traces on its first draw, since they waited for the text shaders. They now draw with the marks, and the tick labels follow once text can draw.
  - Changed: hovering or picking a line tracing a sampled field reaches only the segments within the radius and the line's width of the point along the axis, not every point of every row.

## 0.10.0

### Minor Changes

- dd92235: Traces draw exact to the pixel, grids hold still, the camera's limits are an option, and tiles stay fetched.

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

- dd92235: The module that draws is a tenth smaller: jobs run in a module of their own, the browser encodes the pictures it writes exactly, and flat maps keep areas as they are.

  - Added: `latkit/jobs`, the WebAssembly that does the work views and datasets hand to workers: layouts, lanes, triangles, tile pyramids, decoding vector tiles and GeoJSON, and encoding pictures. A page loads it with its first job. `load({ jobs })` takes its URL or the compiled module.
  - Added: in Rust, `Host::encode` encodes a picture as a file, and `host::read` reads a dataset with GeoJSON parsed in a job.
  - Changed: `latkit/wasm` is 3.50 MB, 1.12 MB with brotli. It was 3.89 MB and 1.23 MB. Workers load the jobs module in place of a second copy of it.
  - Changed: the assets come as a set. A page that gives `load` the URL of `wasm` gives it `jobs` and `worker` too, or `load` rejects with an `invalid` error. Before, a missing asset failed only when a view first needed it.
  - Changed: every job runs in a worker. Before, a small one ran on the frame that asked for it, so a small scene now draws its triangles or layout a frame or two after its first frame. The lanes of up to 32,768 edges are still assigned on the frame.
  - Changed: in Node, `Data.read` reads GeoJSON only after `load({ wasm, jobs })` with the jobs module compiled like the first.
  - Changed: `image.encode` writes JPEG, and PNG of an opaque image, with the browser's own encoder. A worker writes PNG with alpha and WebP, lossless as before. JPEG blends pixels that are not opaque over black.
  - Changed: on a flat map, an area keeps the triangles of its own points. Before, the earth split every triangle along a 2° grid in either projection: the US states took 30,102 triangles on the Mercator map and now take 10,684. The globe still splits them, and changing a scene's projection shapes its areas and lines again.
  - Removed: in Rust, `Job::encode` and `Job::geojson`. `Browser` no longer runs a job on the page without `set_jobs`.
  - Fixed: places and shapes that arrive for rows that had none begin no transition, since those rows drew nothing to ease from. Before, a view with no camera framed a layout that ran in a job only once the scene's ease had passed, 0.3 s by default, and a view kept drawing that long after its areas appeared.

### Patch Changes

- dd92235: Edges joining the same two vertices no longer rebuild their list on every frame their vertices or the camera move.

  - Changed: a mark whose edges bow into lanes lists their pieces again only when its rows or their lanes change. Before, one pair of parallel edges made the whole mark rebuild its list on every frame a vertex moved, and on every frame the camera moved over a tilted plane or the globe. Each such frame also drew the list's whole reserve: 1.8 million instances instead of 200,000 for a graph of 83,000 edges.
  - Changed: a family of more than eight parallel edges still follows its ends and the camera, since its list keeps only the lanes the screen shows apart.
  - Changed: the list holds room for the rows that bow. Before, it held sixteen pieces for every row of the mark.
  - Changed: with `theme.edge.bow` 0, no lanes are derived. Edges joining the same two vertices draw straight, one over another, one instance each, and each is picked as its own row.

- dd92235: A write read through a join or a reference evaluates only the rows reading it in tables of any size, and only scenes with areas multisample.

  - Changed: a write to a table that a mark reads through `from` or `of` evaluates the pages of rows reading the rows written, also when the mark's table is drawn in pages. Before, a paged table evaluated every row it drew, and a table drawn whole evaluated the readers of every row in the written row's page of 4,096.
  - Changed: frames take four samples a pixel only when the scene draws areas, and only on screens below a pixel ratio of 1.75. Vertices, edges, lines, text, and the backdrop antialias in their shaders, so any other scene draws one sample a pixel, keeps no multisampled targets, and reads the depth under the pointer without drawing it again.
  - Changed: a scene with areas draws depth a second time only around the pointer on frames that answer a hover. Before, it drew the whole frame's depth again.

## 0.9.0

### Minor Changes

- 6d460a1: A field can be read from the row a reference names, and a write costs what it changes through joins, transitions, and typed arrays.

  - Added: `field(name).of(reference)`, `{ "field": name, "of": reference }` in JSON, and `Expr::of` in Rust. It reads the field from the row that a reference field of the mark's own table names, such as `field('kv').of('from')` for an edge's first bus. Writing that row changes every row that names it. A row whose reference names no row reads a missing value. In a table too large to draw at once, a position that adds a field read through a reference moves its rows without paging the table again.
  - Changed: a write to a table that a mark reads through `from` or `of` evaluates only the pages of the mark's rows that read the rows written. Before, it evaluated every row of the mark.
  - Changed: a join of two tables that list the same ids in the same order costs nothing: its fields read like the mark's own. Any other join is built again only when either table's rows come or go, not when values change.
  - Changed: a transition freezes and eases only the pages a write changed. Before, each write eased every row of the mark.
  - Changed: `Data.set` and `Data.replace` with typed arrays of numbers, for rows given as a `Uint32Array`, as `{ count }`, or not at all, write the columns directly, without an encoded patch. A whole column written with the ids it already has replaces its pages without a lookup per row.
  - Changed: one pass evaluates a batch of rows, whatever the row's width. Before, a batch took one pass per four words of a row, and one more to pack them.
  - Fixed: an expression that compares a text with `is` and also uses opaque white drew the wrong color, since the two shared a constant.
  - Fixed: a canvas drew one frame more when its element's box was reported without a change of size, as it is once after the canvas is made or its device is replaced.

### Patch Changes

- 6d460a1: A write uploads only the rows it changed, and a field written every frame no longer grows GPU memory.

  - Changed: a row written into a table drawn whole uploads its own values into the page the GPU already holds. Before, the whole page of 4,096 rows uploaded into newly allocated memory. `gpu.work.uploaded` counts the rows written, 16 bytes for one.
  - Changed: a version of a page that no view draws any more is freed at once. Before, it stayed cached, so writing a field every frame grew GPU memory to the budget. A view drawing a `Snapshot` keeps the pages of its version, and `Data.restore` uploads the pages it brings back.
  - Changed: `f32` values upload as stored, without conversion.

## 0.8.0

### Minor Changes

- d700c4e: The WebAssembly carries latkit's shaders, so a page serves one asset where it served two, and a test can lose the GPU device to check what follows.

  - Removed: the `latkit/shaders` asset and the `shaders` option of `load()`. `latkit/wasm` carries the shaders, so `Gpu.create()` no longer waits for a second download or fails when it fails. The WebAssembly is 3.78 MB instead of 3.56 MB (1.19 MB with brotli), the same bytes a drawing page downloaded before.
  - Removed: in Rust, `host::Browser::set_shaders`. A browser build carries its shaders.
  - Changed: a worker URL on another origin, such as a CDN or a webview's resources, is fetched by the page and started from a Blob URL, instead of a Blob URL that imports it. The bundled worker follows the same rule, so latkit loaded from another origin starts its workers.
  - Added: `gpu.lose()`, and `Gpu::lose` in Rust, lose the device as a GPU reset does, so a test can check that views move to a new device.
  - Fixed: a WebGL2 context lost before the browser reports it is the device's loss, not an error. Before, the next frame raised a view error, and a canvas presented through a wgpu surface stopped latkit.

- d700c4e: Any mark can color its pixels with WGSL, and the shaders a view opens with compile sooner.

  - Added: `shade` on every mark, and `Shade` with each mark's `.shade()` in Rust: WGSL that defines `fn shade(f: ShadeFragment) -> vec4f` and colors each pixel before it blends. It reads the mark's color, the pixel, the pointer, the time, and up to eight `inputs`. A shade that reads the time draws every frame, and one that reads the pointer draws as it moves. A shade that does not compile is its mark's failure.
  - Changed: a custom marker sees only `MarkerFragment`, `MarkerColor`, and its own declarations, natively as in the browser. latkit's shader functions, such as `filled`, are no longer in scope, so a marker that called one fails to compile.
  - Changed: a page translates a custom marker or shade once, alone, and appends it to latkit's shaders translated ahead of time. Before, it translated latkit's whole shader again for each variant that drew the marker.
  - Changed: `stats.gpuMs` counts the GPU's work on a frame's commands, not its waits between them. On WebGL2 it read about three times the GPU's work.
  - Changed: the passes that measure rows for a fit no longer hold back a view's first frame. They compile with the drawing pipelines only while a fit that measures rows waits for them.
  - Changed: on Direct3D, edges and lines compile in about two thirds of the time, since their shaders read every value they might need and then select one, rather than branch around reads.

- d700c4e: A view keeps drawing while a new scene's pipelines compile, and draws in depth order with half the compiles.

  - Changed: a scene set while the view draws another draws once the pipelines its frames draw with have compiled. Until then the view goes on drawing, and answering for, the scene before, so changing the space, a projection, or a mark no longer stops the view for a compile. Fits and cameras asked for meanwhile apply to the new scene, and `scene` returns it. A scene set before the view's first frame compiles after the first one, so it draws second.
  - Changed: where depth varies, a mark's opaque pixels draw with the same program as its other pixels, through a copy of its uniform. Each point and stroke draw compiles once instead of twice, so a tilted or globe view draws in depth order from its first frame. Height sorts are the only pipelines left that a view asks for once depth varies.

### Patch Changes

- d700c4e: Time tiles fetched through the app work, and a live run's `refresh()` fetches only what changed.

  - Fixed: `Tiles` with a `fetch` no longer stops latkit on their first file. latkit calls `fetch` after the frame that needs the file, so it may change views and datasets.
  - Fixed: tiles at one URL with different `fetch` functions each draw their own files. Before, every view drew the files of the first.
  - Fixed: a manifest whose `url` lacks `{level}` or `{index}`, or `{field}` when it lists several fields, is invalid. Before, its spans shared files and drew each other's entries.
  - Changed: `tiles.refresh()` keeps the base dataset and the spans the earlier frames filled. It fetches the last span of each level again, which draws what it held until the new one arrives, and every span that failed. Before, it fetched the base again and redrew every span. A manifest that names another base, `chunk`, or `url` starts over.
  - Changed: a span that could not be fetched is fetched again on the next refresh, and each tile failure is reported once.
  - Changed: a trace whose plot window needs more than 64 spans draws from a coarser level, rather than its middle at the finer level between coarse placeholders, which broke the line.

## 0.7.1

### Patch Changes

- 95aff96: Views in WebKit show their first complete frame in about a second instead of nine, and `gpu.done()` resolves once the GPU finishes, even on a page that reads back every frame.

  - Fixed: each frame is fenced before the page copies the canvas, and a wait for the GPU with no work given to it since joins the newest fence. WebKit reported a fence made after a canvas copy as unsignaled for about 8 seconds after the GPU finished, which held back pipelines, readbacks, and `gpu.done()`.
  - Fixed: once a fence signals, the waits on every fence before it end too, so a fence a browser reports late no longer holds back the waits made after it.
  - Fixed: `gpu.done()` and `gpu.step()` wait for the work submitted before the call and the readbacks it copies, not for a moment with no readback in flight. On a page that reads back every frame, such as a plot fitting its range to streaming data, `gpu.done()` timed out in WebKit.
  - Changed: readbacks submitted together share one fence.

## 0.7.0

### Minor Changes

- e87e862: Pages show their first frame sooner on a first visit, and no longer stall right after it. The WebAssembly is 3.4 MiB instead of 6.0 MiB (1.0 MiB with brotli instead of 1.3): latkit's shaders are translated to GLSL when it is built, so the page carries no WGSL compiler.

  - Added: the `latkit/shaders` asset, the shaders translated for WebGL2. `load()` downloads it while the WebAssembly compiles, wherever a browser canvas is available. Its `shaders` option names another URL for it. Only drawing needs it, so a failed download fails `Gpu.create()` with an `io` error, and the next call downloads it again. A file from another version is refused.
  - Added: a custom marker's WGSL translates in a module of its own, the `latkit/wgsl` asset, which a page loads the first time it draws a custom marker. The `wgsl` option of `load()` names another URL for it.
  - Added: in Rust, `host::Browser::set_shaders` hands over the shaders before a `Gpu` is created, and fails unless they are the file the same build wrote. `host::Browser::set_translator` provides the custom marker translator. The `wgsl` feature translates custom markers in the page instead, and lets the WebGL2 device take WGSL shader modules.
  - Changed: every raster pass writes one color target. Chrome on Windows built a shader again on its GPU thread the first time a pass wrote several, which froze the page for up to 1.6 s after its first frame.
  - Changed: the WebGL2 canvas latkit draws through starts at the screen's size. Growing it waited for every shader compile in flight.
  - Changed: shaders read columns and lists without branching around texture reads or indexing vectors at runtime, which made the D3D compiler behind Chrome on Windows take several times longer. Column descriptors are 8 words.
  - Changed: a channel kernel is written in GLSL in a browser and evaluates only the channels the words it writes depend on.
  - Removed: in a browser, `Gpu::from_wgpu` takes only the WebGL2 device of a `Gpu` from `Gpu::new`.

- e87e862: The diagram space is gone. Graphs draw on a plane or the earth, a plain length is CSS pixels everywhere, and the wasm is about 8% smaller. Laid-out graphs open faster, and dragging their rows costs only the rows that move.

  - Removed: the `diagram` space and its theme group: `Diagram`, `DiagramTheme`, and `ShadowTheme`.
  - Removed: vertex `ports`, `contains`, and `shadow`, with `Port` and `Side`. Edges without `ends` are no longer nets, and the `orthogonal` route is gone, so `Route` is `straight` or `geodesic`.
  - Removed: grid `snap`, the theme's `edge.spacing`, `px()`, and the `{ px }` form of sizes and lengths. A plain number is already CSS pixels.
  - Removed: `Hit.port`, `End.port`, and the `port` option of `view.screenOf`. In Rust, `View::screen_of(row)` takes only the row, and `Host::measure` is gone.
  - Changed: the block marker's corner defaults to the theme's new `vertex.corner`.
  - Changed: with a layout, a vertex mark draws each row at its data's position and takes the layout's place only where the data gives none. Editing positions, as a drag does every frame, no longer rebuilds every row's place: only the rows written are checked for a lost position. Nets' stars recompute only when their members, the members' positions, or the layout's places change.
  - Changed: a layout small enough for the frame runs on it rather than in a host job, and a stress layout stops once it settles. Layouts place points, so they no longer size, nest, or pad rows, and a layout job carries a third of the bytes per row.
  - Fixed: layouts and `view.neighbors` now follow nets drawn with `joins`. Each net links its first member to every other.

- e87e862: latkit draws with WebGL2 in browsers instead of WebGPU, so a page draws wherever the browser has WebGL2.

  - Changed: in a browser, a `Gpu` is a WebGL2 device, and `Gpu.create()` rejects with an `unsupported` error where the browser has no WebGL2. latkit no longer uses `navigator.gpu`.
  - Changed: a `Gpu`'s default budget is half the device's addressable word-texture capacity, at most 1 GiB, instead of half its largest storage buffer.
  - Changed: `stats.gpuMs` comes from WebGL2 timer queries (`EXT_disjoint_timer_query_webgl2`), and is 0 where the browser has none.
  - Changed: in Rust, the WebGL2 device reports the wgpu calls WebGL2 cannot do, such as compute passes, query sets, and indirect draws, as validation errors to its error scopes and handler.
  - Removed: in Rust, the `gpu` feature without `web` no longer builds for `wasm32`, where it could not draw. Use `web` to draw, or `default-features = false` for data alone.

### Patch Changes

- e87e862: A view is complete as soon as everything it draws is ready, so `done()`, `complete`, and pictures come sooner on a cold page.

  - Changed: `complete`, `done()`, and `waiting`'s `compiling` wait only for the pipelines frames draw with: those of the marks and any text, transitions while rows ease, the glow while a row is lit, and layers where depth varies. The pipelines that answer the pointer, picks, and queries no longer count, so on a cold page the first hover or pick can answer a moment after `done()`.
  - Changed: a change that arrives before the transition pipelines have compiled applies at once, as with motion off, instead of compiling them in the frame that needs them.
  - Changed: `gpu.step(now)` returns a promise that resolves once the GPU has finished the frame and its readbacks. `gpu.done()` still also waits for every requested pipeline.
  - Removed: compiling ahead the pipelines nearly every scene uses when the first view opens. A GPU compiles only what its views ask for.

- e87e862: Pages read GPU results back in Firefox without stalling it.

  - Fixed: buffers that results are read back from are made for reading, which Firefox reads without stalling the GPU.
  - Fixed: waiting on the GPU asks the browser to flush its commands, which Firefox needs before it promises to finish them.

- e87e862: Rows that stand at different heights sort again in a quarter of the GPU time, and only every 0.1 s while their heights stream in.

  - Changed: sorting rows by height takes about a quarter of the GPU time it did: 21 ms instead of 83 ms for the 1.2 million line segments of a 100,000-bus grid on a globe.
  - Changed: while heights change in every frame, as when they stream in, a view sorts them again at most every 0.1 s, and once more after they stop. A picture or video frame always draws every row in order.
  - Changed: heights within about 0.01% of each other count as one, and keep their table order.

- e87e862: Flat views open about 0.4 s sooner, and stepping through rows with the keys costs the same however many rows are in view.

  - Fixed: a view whose depth doesn't vary (straight down at a plane or flat map, with no rows raised) no longer compiles or waits for the opaque draws and the height sorting it never uses, so `complete`, `done()`, and pictures come sooner. A view asks for them once its camera tilts, the globe shows, or rows stand at heights, and until they are ready it draws its marks in order.
  - Fixed: Tab and the arrow keys find the next row on the GPU and read back only that row. Before, the first step read back and decoded every row in view, an 80 ms frame on a view of a few thousand rows.
  - Changed: an arrow that finds no row its way pans the camera a frame or two later, once the GPU has looked.

- e87e862: Large datasets with references take about 40% less WebAssembly memory, which a page never gives back.

  - Changed: a reference whose ids arrive as `u32` keeps them as `u32`. Where they name the rows of a table with counted ids, its resolved rows share the ids' pages instead of copying them. An id too large for `u32` widens the reference's ids to `u64`. A grid of a million buses and two million lines takes 30 MiB less once read.
  - Changed: a background job's input is written once into room made for all of it, and the lanes job writes each line's ends straight from their pages. Loading that grid peaks 31 MiB lower.

- e87e862: WebGL2 pages show their first frame about a quarter sooner on a first visit. Frames that zoom, evaluate rows, append, or answer the pointer draw faster in Chrome on Windows.

  - Changed: a pipeline waits to compile while more urgent ones still compile, so the pipelines a first frame draws with have the browser's compile threads to themselves. Those that answer the pointer and draw lit rows and layers start once the GPU has finished the frames drawn with the others.
  - Changed: building a pipeline no longer asks the browser for its errors, which waited for the browser's GPU process while it compiled. Translation and link errors still refuse the pipeline.
  - Fixed: a shader's flat values come from the first vertex of each primitive, as WGSL defines. Chrome on Windows no longer runs every mark's draw through a geometry shader to take them from the last.
  - Changed: the rows a frame evaluates are copied into place with one draw per batch, instead of a texture copy per page and row span.
  - Changed: one task waits on everything the GPU is doing. Compiling programs are checked every 4 ms instead of every browser task, which kept the page busy while a scene compiled.
  - Fixed: a native `Gpu` no longer opens OpenGL alongside Vulkan, DirectX 12, or Metal. On Windows, opening several at once from different threads could hang.

## 0.6.1

### Patch Changes

- 8570a4d: Where rows stand at different heights, a near line or marker thinner than a pixel shows over the rows behind it.

  - Fixed: where depth varies, the pixels a line or marker covers only in part blended in table order, so a row behind could draw over a nearer one, and a raised line passing in front of many lower ones looked dotted. A mark whose rows stand at different heights now draws them lowest first, which is farthest first wherever they overlap, from any camera. A line sorts by its middle.
  - Changed: rows at one height keep their table order, so tilting the camera changes only where rows appear. Moving the camera sorts nothing. Rows sort again only when their heights or the rows change.
  - Changed: when the pointer is as near several rows of a mark, hover picks the one drawn on top.

## 0.6.0

### Minor Changes

- 3eee5dc: What every input does is set in one place, `controls.gestures`, with new gestures, and a cancelled or abandoned input never acts late.

  - Added: `controls.gestures` sets what each input does: a drag with the `primary`, `secondary`, or `middle` button, the `wheel`, and two fingers that `pinch`, `twist`, or `slide`, each with any modifier keys held, as in `{ 'shift+primary': 'box', wheel: 'pan' }`. The actions are `pan`, `turn`, `tilt`, `zoom`, `box`, `zoomBox`, `scrub`, `connect`, and `none`. In Rust, `Gestures::with(key, action)` builds them.
  - Added: new gestures. The wheel can pan, turn, or tilt, so a trackpad can scroll the map. A drag can tilt alone, or zoom to frame a box. Two fingers can twist to turn and slide to tilt.
  - Added: the drag phase `cancel`. Its `patch` writes the row's position fields back exactly as they were when the drag started, however the camera moved and whatever grid drags snap to. Fields that were empty, as for a row a layout placed, are emptied again.
  - Added: `Input::Blur`. Losing focus stops every gesture and the keys, and forgets the pointer until it moves again, so nothing asked for before lands and nothing stays hovered. A page's canvas sends it when it loses focus, and cancels a pointer it loses capture of.
  - Changed: every button presses alike and does what its input says. A middle press never clicks, and a middle drag on a row of a draggable mark drags the row, as a primary drag does.
  - Changed: a cancelled pan or turn no longer coasts, a cancelled drag reports `cancel` instead of `end`, and a cancelled press never clicks, selects, connects, or opens a menu.
  - Changed: a probe asked for before the pointer left, or before a cancel, no longer sets the hover when its answer arrives.
  - Changed: a canvas's `touch-action` follows its views: `none` when a finger dragging does something, `pan-x pan-y` when only two fingers do, and otherwise `manipulation`, so views that only inspect let the page scroll.
  - Changed: pointer points allow for CSS transforms that scale the canvas, and a wheel that scrolls by pages scrolls by the canvas's size.
  - Changed: where the camera cannot turn, in a diagram or on a plot, a turning drag pans.
  - Removed: `controls.pan`, `zoom`, `turn`, `selectBox`, `connect`, and `scrub`, and the `Zoom` type. Each is now a `gestures` entry:
    - `pan: false` is `{ primary: 'none', middle: 'none', slide: 'none' }`.
    - `zoom: 'modifier'` is `{ wheel: 'none', 'control+wheel': 'zoom', 'meta+wheel': 'zoom' }`, and `zoom: 'off'` is `{ wheel: 'none', pinch: 'none' }`.
    - `turn: false` is `{ secondary: 'none', 'shift+primary': 'pan' }`.
    - `selectBox: true` is `{ 'shift+primary': 'box' }`, `connect: true` is `{ 'alt+primary': 'connect' }`, and `scrub: true` is `{ primary: 'scrub' }`.

### Patch Changes

- 3eee5dc: A call that times out cancels the work it gave up on, and destroying an object always frees its memory.

  - Fixed: a call given no signal times out once, after 30 seconds across all its steps, and cancels the fetch or stream read it gave up on. Before, each step waited 30 seconds of its own, and a stalled read stayed running with its stream locked.
  - Fixed: `destroy()` frees an object's memory even when its own cleanup throws.
  - Changed: `Data.read` waits for latkit to load within its signal too, and reads a `Response` or `Blob` as a stream, so its signal cancels the read.

- 3eee5dc: Where depth varies, lines and markers no longer draw dark outlines where they cross, or stripes where they overlap.

  - Fixed: a pixel that a line or marker covers only in part blends over what lies behind it, not over the background. Since 0.5.1, lines thinner than three device pixels hid what lay behind the pixels they partly covered, which drew dark outlines where lines crossed and stripes where they overlapped.
  - Changed: where depth varies, the opaque pixels of every mark draw first and keep their depth, and every other pixel then blends over them in mark order. A line or marker too thin to cover a pixel fully no longer hides what lies behind it, but it still draws over every opaque mark behind it, whatever the order of the marks. Faces and areas also lie under every pixel that blends.

- 3eee5dc: Looking straight down, elevation only decides which rows show on top, and rows rise into view as the camera tilts.

  - Changed: looking straight down, each row draws over its ground position, and elevation only sets its depth, so a higher row hides a lower one across every mark with no perspective shift. Lines between rows at one place, such as poles, shrink to a point under them. Over the first 10° of tilt, rows rise smoothly to where they stand.
  - Changed: panning, turning, and zooming keep a raised row under the pointer while rows rise into view, and positions under the pointer and drags read where the row draws.

## 0.5.1

### Patch Changes

- fed582c: Where depth varies, thin lines and small markers hide what lies behind them, and rows a selection dims never hide the selected ones.

  - Fixed: where depth varies (a tilted camera, the globe, or raised vertices), a line thinner than a device pixel or a marker smaller than one now hides what lies behind it, so the nearest row shows whatever the order of the marks. Before, they hid nothing, and the row drawn last showed.
  - Changed: an opaque row hides what lies behind it wherever its shape covers a pixel, never by how its edge is smoothed. A shape thinner than three device pixels also hides the pixels it partly covers, so it hides at least one. Translucent rows, including rows a selection dims and rows fading in or out, hide nothing, so the selected rows show over the dimmed ones. Dash gaps, comets, glows, shadows, status rings, an icon's clear pixels, and a custom marker's holes hide nothing either.

- fed582c: A lost device moves each view to a new one as the same view, so nothing that waited on it is cancelled.

  - Changed: when the device is lost, each view moves to the new device as the same view. Promises waiting on it (`fit`, `done`, `arrange`, `pick`, and other queries), its listeners, and pictures and videos drawing it carry over and answer there, where before they rejected as `cancelled`.
  - Changed: a moved view keeps its laid-out places, camera, clock, and `stats`, so it lays out nothing again and its effects go on.
  - Changed: latkit requests the new device once the page is in the foreground, as phones often lose the device in the background. If the page goes to the background before the device comes, latkit asks once more when it shows again.
  - Changed: `gpu.work` counts the work of every device the GPU moved to.
  - Changed: in Rust, `View::move_to(&gpu)` moves a view in place and can't fail.
  - Removed: `View::rebuilt` in Rust, replaced by `View::move_to`.
  - Fixed: a device given up for lack of memory no longer reports a `limit` error, since its views go on drawing on the new device.
  - Fixed: a moved view reports its failures again only when they change.

- fed582c: Every pipeline builds in Safari and other WebKit browsers, and a pipeline a browser refuses to build is an error instead of a blank view.

  - Changed: pipelines pass no pipeline constants. Each pipeline's shader declares the values it is built for as constants in its own code. WebKit, which every iPad and iPhone browser uses, refused pipelines given constants their stages don't read, so views there drew only their background.
  - Changed: when a browser refuses to build a pipeline a view needs, the view reports an `unsupported` error that names the pipeline and gives the browser's reason. It draws nothing, so the other views keep drawing, and `done()` and pictures of it fail with that error.

## 0.5.0

### Minor Changes

- 542db73: Titles, legends, and axes lay out around the marks, failures are state instead of errors, and views share their selection and hover.

  - Added: `place` on a `title` and on each `legend`: a side (`'top'`, `'right'`, `'bottom'`, `'left'`) takes room from the marks, so fits frame clear of it and marks stay out of it, or a corner (`'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`) sits over the marks on a backdrop. A plot defaults to the top and right, other spaces to the top-left and bottom-right corners. A title and legends in one place stack and wrap into another row or column instead of running off the view. A legend's bar stands upright on the left and right, and shortens to fit the room along it. Rows under a title or legend can't be hovered or picked, and the keys step past them.
  - Added: `unit` on a plot `Axis` and on a `legend`, written after the last tick's value, as in `" s"` or `" pu"`.
  - Added: a `failures` change event with every failure, and `Scene::failures(sources)` in Rust, which lists what a view would report.
  - Added: `view.hovered` can be set to any row, and `related()` reads whether a row is one reference from a selected or hovered row.
  - Changed: `title` takes a text or `{ text, subtitle, place }`, and `legend` a title or `{ title, unit, place }`.
  - Changed: an option that can't be read, or that the scene can't use, draws as if unset and is listed in `failures`, like an option that doesn't fit the data. Only a scene whose space, marks, or a mark's dataset and table can't be read throws. A second mark with an earlier mark's key draws nothing.
  - Changed: `error` events report only what stops a view drawing, and pictures and videos fail only on those. A picture draws a view with failures as the view does.
  - Changed: the selection keeps rows that no mark of the view draws, so views can share it. Rows one reference from a selected or hovered row, through any reference field, such as a bus's branches and machines, draw on top, and a selection keeps them bright while the rest dim. They no longer glow, which only selected and hovered rows do. A hover change costs time in proportion to the hovered row's references, not the selection.
  - Changed: every mark shows which of its rows are selected and hovered, including marks with `pick: false`, where they used to dim. `pick` only decides whether the pointer hovers, clicks, and picks a mark's rows.
  - Changed: `view.hovered` is a row. A row set there stays until what the pointer or keyboard hovers changes. The `hovered` event still carries the hit, and fires as the pointer moves between samples of one traced line.
  - Changed: titles, legends, and axes space themselves in ems of the theme's text size, so views that share a theme line up, and a plot's axes keep the same padding from the view's edges.
  - Changed: titles, legends, and axis labels align their text by its line box, without the padding around its raster.
  - Changed: in Rust, `View::new` and `set_scene` no longer fail, `View::hovered` returns a `Row`, and `Raster` has a `line_box`.
  - Removed: `subtitle`, now part of `title`, and `Scene::validate` in Rust.
  - Fixed: a y-axis title no longer overlaps the top tick's label.
  - Fixed: text set before a web font loads is set again once it loads.

### Patch Changes

- 542db73: GPU memory is freed when latkit is done with it, pipelines compile once in every browser, and every view reports each device error.

  - Added: `destroyed` in `gpu.work`, the bytes of GPU memory latkit freed.
  - Changed: GPU memory that latkit replaces, or that a closed view, canvas, or finished picture leaves behind, is freed by the next frame, not when the browser collects it.
  - Changed: the budget defaults to half the device's largest storage buffer, at most 1 GiB.
  - Changed: a large load grows the page pool once, instead of doubling it page by page.
  - Changed: a device without the memory to grow the page pool lowers the budget to what it gave. In a browser, latkit gives up that device, and the views move to a new one within the lowered budget.
  - Changed: each pipeline compiled in the background is the one drawn with, in every browser, instead of being compiled again. Every pipeline's label names it exactly.
  - Changed: every view reports each error the device raises once, whichever view draws first, even while nothing draws. Failures of the jobs and fetches a view started reach that view alone.
  - Changed: a custom marker whose WGSL does not compile is listed in `failures` as `marks[i].marker` and never draws, instead of an `error` event.

## 0.4.2

### Patch Changes

- 80a7772: An empty table with a priority draws, `Patch` bundles without WebAssembly, and nothing runs after an internal error.

  - Changed: `Patch.read()` of JSON needs `await load()` first, and rejects with an `unloaded` error before then. A bundle that only builds patches and reads their bytes leaves out the WebAssembly bindings, about 72 KB.
  - Changed: once latkit stops after an internal error, pending waits reject with the `stopped` error at once instead of timing out.
  - Fixed: an empty table with a `priority` no longer stops latkit.
  - Fixed: resizing a canvas after latkit stopped no longer causes a second internal error.

## 0.4.1

### Patch Changes

- f42e09e: Builds are reproducible, and the crates come out with the npm package again.

  - Changed: the shaders link in the same order on every build, so a package rebuilt from a commit matches the one published from it. 0.4.0 reached npm only, since its release could not rebuild the same package to resume; this release publishes the crates too.

## 0.4.0

### Minor Changes

- 365dc73: Tiles fetch through the app and refresh, labels write numbers, options that do not fit draw as if unset, and views survive a lost device.

  - Added: `new Tiles(name, url, { fetch })` fetches the tiles' files through the app, and `tiles.refresh()` fetches the index again, keeping the time spans the earlier frames cover. `Tiles` documents the time tile manifest.
  - Added: number labels, written on the GPU each frame: `label: { text: field('vm'), precision: 3, unit: ' pu' }`, with an axis's `format`.
  - Added: `domain('all')` maps every value a field holds, in every frame of a sampled field.
  - Added: `expr.fallback(other)`, and `meters(length)` for lengths on the earth.
  - Added: `view.fit()` resolves to the camera it framed, or `null` when replaced. `fit({ tables })` frames whole tables. A reveal asked while a fit is due follows it.
  - Added: `view.done()`, which resolves once the view is complete.
  - Added: `view.arrange('all')` lays out every row, positions given or not.
  - Added: a `drag` event's `patch` writes the dragged row's new place.
  - Added: `controls.scrub`: clicking or dragging across a plot moves `at`, emitting an `at` event.
  - Added: `view.screenOf(row, { port })`.
  - Added: `theme.contrast`, the least WCAG contrast that colormap colors keep with the background.
  - Added: `patch.byteLength`, and `signal` on `Gpu.create` and `View.create`.
  - Added: when the device is lost, latkit requests a new one and moves the views, canvases, and frame listeners to it with their state. In Rust, `View::rebuilt(gpu)`.
  - Changed: an option that does not fit the data draws as if unset and is listed in `failures`, instead of failing the mark. A label whose text does not fit shows none.
  - Changed: `view.camera`, `fly`, and `View.create`'s `camera` take a partial camera. A pitch or bearing alone turns the camera and keeps a fit due.
  - Changed: writing values a table already holds changes nothing, so nothing evaluates again. `replace` with the same ids writes over the table like `set`.
  - Changed: `frames()` may write a level's last entries again, as a bucket fills.
  - Changed: an edge without a color blends its ends' colors per row, also where its own color is missing.
  - Changed: `colormaps()` returns each map's colors and needs no WebAssembly.
  - Changed: `load({ worker })` takes the worker asset's URL. One on another origin starts through a Blob URL.
  - Changed: a plot's grid lines draw under its marks.
  - Changed: a fit of markers sized in units frames the same from any zoom.
  - Changed: `complete` is false until a frame draws the view, and `View.create` compiles its scene against its sources, so the first frame reports no failures the data resolves.
  - Changed: points and strokes write depth only where opaque, so their edges no longer shimmer.
  - Changed: an empty table takes the id kind of its first ids, and NaN in a reference's `Float64Array` names no row.
  - Changed: JSON errors no longer end in " at line N column M".

## 0.3.1

### Patch Changes

- 519dfc8: Views place their camera once positions settle, draw the nearest mark where depth varies, and stop cleanly after an internal error.

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

## 0.3.0

### Minor Changes

- 3ef5134: `View.create` opens a view in one call, a mark's kind key holds its table, and `Data` applies changes directly.

  - Added: `View.create(canvas, scene, { region, camera, sources, gpu, pixelRatio })` draws a view on a `<canvas>` or `OffscreenCanvas`, over any views already there. With a `null` canvas, the view draws only into pictures.
  - Added: views share the first `Gpu` created, and `View.create` creates one if there is none. `view.region` moves a view, and `view.gpu` is its GPU.
  - Added: `data.table(name)` and `tiles.table(name)` return a `Table` for a mark to draw or `field(name).from(table)` to read. A view loads every dataset its scene's tables belong to, so `sources` lists only datasets named as `[data, table]`.
  - Added: a `Data` method for every `Patch` change, applied immediately: `axis`, `replace`, `set`, `remove`, `append`, `forget`, `frames`.
  - Added: `Shot.of(view, options)` captures what a view's canvas shows. `new Shot(size, { views })` draws views in their own regions, or in another region given as `{ view, region }`.
  - Changed: a mark's kind key holds its table, next to its options: `{ vertices: grid.table('Bus'), radius: 4 }`, or `{ "vertices": ["grid", "Bus"], … }` in JSON. This replaces `{ vertices: { of: ['grid', 'Bus'], radius: 4 } }`.
  - Changed: errors name the option's path, such as `marks[1].radius`.
  - Changed: `replace` and `set` given only fields write rows `0` to `n - 1`.
  - Removed: `gpu.view`, `gpu.canvas`, `Canvas` (with `canvas.show(views)` and its `panels`), and the `Panel` type.

- 3ef5134: A flat map shows one world, and every camera move stays within the camera's zoom and pan limits.

  - Changed: a flat map's ground ends at the antimeridian, as it ends at Web Mercator's latitude limit.
  - Changed: on a flat map, the camera zooms out only until the whole world fits inside the insets, and pans only until the world's edges meet the view's edges.
  - Changed: on a globe, the camera zooms out until the globe spans a third of the view's shorter side.
  - Changed: setting the camera, flights, fits, orbits, and gestures keep the camera within its zoom and pan limits, and its pitch within 75°. After a fit, the limits narrow to the area the fit framed.
  - Changed: a `camera` event fires when a resize, new insets, or a new space moves the camera back within its limits.
  - Changed: on a flat map, a flight eases across the world instead of the short way over the antimeridian. On a globe, longitude still turns the short way.
  - Fixed: panning a flat map no longer wraps its center across the antimeridian, which moved every row a world away.
  - Fixed: a scene with another kind of space drops the old space's fits and any camera motion in progress.

- 3ef5134: Labels are placed from each frame alone, with no fades. Where labels would overlap, the row drawn on top keeps its label.

  - Added: a label's `text` takes a `when` that picks the text field or `null`. A row whose text is missing has no label, so `when(zoom().ge(6)).then(field('name')).otherwise(null)` labels rows from zoom 6 on.
  - Changed: a row whose text is empty has no label, like a row whose text is missing.
  - Changed: a label shows when its row is visible, its text is set, and the text fits, for example inside a block.
  - Changed: labels beside or along their rows never overlap. Where they would, the row drawn on top wins, so a mark's `priority` decides.
  - Changed: only labels that show need their texts, so a view of any size settles with as many texts as fit on screen.
  - Changed: labels move with the camera in the frame it moves, keep showing while their mark gains texts, and never take another row's state when tiles change.
  - Changed: when the text atlas is full of texts in view, it accepts no more until the view changes, instead of evicting texts it still shows.
  - Changed: `'labels'` in `Waiting` means label texts are being read back or are not yet set.
  - Removed: a label's `priority` and `max`, and label fades. A mark's `priority` orders its drawing, its thinning, and its labels.

- 3ef5134: Views draw from sources, every wait can be cancelled, colors and lengths are typed, and large tables draw in pages that stay on the GPU.

  - Added: `view.sources`. A source is a `Data`, drawn at its latest version from the frame after each patch. It can also be a `Snapshot`, one fixed version (`data.snapshot()`, `data.restore(snapshot)`), or `Tiles(name, url)`, time tiles or vector tiles fetched once per GPU.
  - Added: `view.snapshot(name)` returns what a view currently draws of a source.
  - Added: `load({ wasm, worker })` loads the WebAssembly. Using the library before it finishes throws `unloaded`.
  - Added: every class and builder is exported from `latkit`.
  - Added: every wait takes `{ signal }` and times out after 30 seconds by default: picks, `screenOf`, `arrange`, pictures, encodings, videos, `gpu.done()`, and `gpu.landed()`. A timeout rejects with `timeout`. An abort or a destroyed view rejects with `cancelled` and drops the work in progress.
  - Added: `new Shot(size, { scale, transparent, capture, elapsed })`, where `capture: 'now'` takes views as they are, and `shot.video({ fps, output, bitrate, signal })`.
  - Added: `px(n)` and `units(n)` set a length's unit. Lengths default to position units in diagrams and CSS pixels elsewhere. A stroke in pixels keeps its width as a diagram zooms.
  - Added: theme groups `text`, `vertex`, `edge`, `line`, `area`, `focus`, `flow`, `diagram`, `earth`, and `plot`.
  - Added: a comet's `flow.spacing` and `flow.length` take `{ px }` or `{ units }`.
  - Added: `diagram.outline`, `corner`, `portSize`, and `bend` style blocks, groups, ports, and wire bends.
  - Added: `shadow: true` on blocks and groups casts a soft shadow `diagram.shadow.lift` below them.
  - Added: `Gpu.resident` and `Gpu.uploading`, the bytes on the GPU and the bytes waiting to upload, across all its views.
  - Added: `Work.packed`, `Work.resolved`, `Work.cleared`, and `Work.uploads`.
  - Added: `Handle`, the base class of every object that holds memory (`Data`, `Snapshot`, `Gpu`, `View`, `Image`), with `destroy()` and `using`.
  - Added: `Dataset`, the reads that `Data` and `Snapshot` share.
  - Added: `colormaps()` lists the catalog's colormaps with their names, labels, and kinds.
  - Added: the package's types document every member, enumeration value, union form, and options field.
  - Added: the CLI's `--camera` takes a camera as JSON or as a file, like `latkit query` takes a query.
  - Changed: `view.scene`, `view.selection`, `view.screen(position)`, `view.position(point)`, `view.screenOf(row)`, `view.waiting`, and the `hovered` and `selection` events replace the methods and events removed below.
  - Changed: every error the package throws is a `LatkitError` with a `code`.
  - Changed: a failed fetch or an error status is `io`. A call on a destroyed object has the new code `destroyed`. A bad `Patch.stream` limit and a `Video` drawn out of turn are `invalid`.
  - Changed: errors from the video encoder and worker jobs keep their codes. An abort during a fetch rejects as `cancelled` or `timeout`.
  - Changed: latkit's bytes carry no version or flags. A frame's 12-byte header is the magic `LATK` and the frame's length. Files written by earlier versions no longer open.
  - Changed: `theme.missing` is the color a colormap gives a missing value. An option given a missing value (`null`) still takes its theme value.
  - Changed: `new Patch(dataset)` names its dataset.
  - Changed: `Patch.read(source)` reads a patch's bytes or JSON, and `Data.read(source, { name, base })` reads a dataset's bytes, JSON, or GeoJSON. Both read from a `ByteSource` (bytes, a `Blob`, a `Response`, a byte stream or async iterable, or a URL) within the wait's `signal`.
  - Changed: the signatures `patch.append(table, at, fields, { ids })`, `patch.frames(table, field, { level, first, at, values })`, and `data.envelope({ table, field, range, spans, ids })`.
  - Changed: a video's size rounds down to whole 4×2 blocks, in the browser and the CLI. A smaller size is `invalid`.
  - Changed: `view.screen` and `view.position` given the wrong number of coordinates throw `invalid` instead of returning `null`.
  - Changed: the `'earth'` space takes `{ earth: { projection: 'mercator' | 'globe', graticule, daylight, atmosphere } }`. Its ground color is the theme's `earth.ground`.
  - Changed: a table too large to draw at once draws in pages that keep their place on the GPU as the camera moves.
  - Changed: pages no longer drawn stay on the GPU while the budget allows, so coming back to them is free.
  - Changed: a write rebuilds only the pages it touched, and appending rows never thins what draws.
  - Changed: lanes, net stars, joins, and fitted domains follow the data, not the camera.
  - Changed: edges with far-apart ends draw within the budget. Their end rows load one by one, and only edges whose ends moved look them up again.
  - Changed: a hit describes the frame it came from.
  - Changed: all views of a GPU draw one frame together, and `Budget.uploadPerFrame` caps what they upload in it.
  - Changed: editing a diagram recomputes only the moved blocks, the groups around them, and the wires near them.
  - Changed: map tiles draw in the frame they finish loading.
  - Changed: a plot measures the space its axis labels and titles need.
  - Changed: a GPU picks its antialiasing once.
  - Changed: zooming at a fit's limit keeps the center.
  - Removed: `view.setData`, `view.setTiles`, `view.removeData`, and `view.data(name)`. Use `view.sources`.
  - Removed: `view.show(scene)`, `view.select(rows)`, `view.point`, `view.ground`, `view.locate`, and the `hover` and `select` events.
  - Removed: `Stats.waiting`, `Stats.uploading`, `Stats.resident`, and `Stats.budget`.
  - Removed: `loadLatkit()` and its result object, and `latkit/core`.
  - Removed: `createWorker`. Use `load({ worker })`.
  - Removed: `{ deadline }` options. Use `{ signal }`.
  - Removed: `Shot`'s builder methods, `shot.image(views)`, and `shot.video(gpu, fps, output)`.
  - Removed: `Patch.to`, `Patch.fromBytes`, `Data.load`, and `Data.tables`.
  - Removed: `data.ids()`, `data.fields()`, and `data.span`. Use `describe()`.
  - Removed: the positional `envelope`.
  - Removed: `expr.of(data, table)`. Use `from`.
  - Removed: the `'mercator'` and `'globe'` spaces. Use `earth`.
  - Removed: flat theme keys such as `vertexRadius`, `fontSize`, and `edgeSpacing`.
  - Removed: reading a string as a color only when it begins with `#`.
  - Removed: `Flow.units`.
  - Removed: shadows on edges, lines, areas, and faces, and the theme's `shadow.light` and `shadow.softness`.
  - Fixed: when a view's next version does not fit, the view releases what it draws so the new version can load. If nothing fits, it reports a `limit` error and stops.
  - Fixed: on the earth, sizes in `units(n)` are degrees, like comet lengths, not Mercator radians.
  - Fixed: zoomed in close on the globe, paged tables and vector tiles keep drawing their finer tiles. Past about zoom 12 they fell back to the coarsest.
  - Fixed: a text the host cannot rasterize reports one error, not one every frame it shows. A text with nothing to draw is not an error.
  - Fixed: a layout or shaping job that fails runs once until its inputs change, not every frame.
  - Fixed: at the GPU's texture-layer limit, a new icon fails with a `limit` error instead of overwriting the last one.
  - Fixed: `view.screenOf` returns `null` for a hidden stroke or face, and for a face beyond the globe's horizon.
  - Fixed: edges and faces no longer compile an unused bounds pipeline before their first frame.
  - Fixed: a `priority` that tests a field only with `contains()` now reads that field when ranking a paged table's rows.
  - Fixed: a JSON patch's errors name the failing change the same way wherever they are found, such as `[0].append.fields.x`.
  - Fixed: a tile index that is neither TileJSON nor PMTiles fails as `invalid`, and tile errors keep their code.
  - Fixed: when the CLI cannot write an output, its error names that output, not the frames file.
  - Fixed: a transition that starts in the frame a mark's tables grow no longer writes its rows over other data on the GPU, which could draw rows in the wrong colors or places.

- 3ef5134: The command line plays an axis span.

  - Added: `--span FROM,TO` and `--rate`. A video or image sequence without `--frames` plays the datasets' span.
  - Added: with `--span`, each `--frames` line applies at its `at`, and the camera flies between lines that set it.
  - Added: `view.fly(camera, seconds)`.
  - Changed: setting or flying the camera replaces a pending fit.

- 3ef5134: A vector tile costs only the rows it brings, and the tiles drawn largest split first.

  - Changed: an arriving vector tile appends its rows, so rows already drawn do not upload or evaluate again.
  - Changed: a tile that stops drawing keeps its rows and draws them again if it comes back. Once rows that no tile draws outnumber the drawn rows by a page, they are all removed. Until then, `view.snapshot(name)` of a vector source includes them.
  - Changed: tiles split by the area they cover on screen, so tiles near the globe's edge and a tilted map's horizon stay coarse.
  - Changed: when the tile budget runs out, the tiles drawn largest split first, for vector tiles and paged tables alike.
  - Changed: at most 128 vector tiles draw at once.
  - Changed: a vector table draws each tile's rows in the order of the mark's `priority`, highest on top.
  - Fixed: a flat map no longer fetches tiles past the antimeridian as if they were near.
  - Fixed: two tiles arriving together with different kinds for the same field no longer fail every update.

- 3ef5134: One way to write a value in every option and query: `'$name'` reads a field, any other string is a CSS color, and `null` is missing.

  - Changed: in a scene or a query, a string `'$name'` reads field `name` and any other string is a CSS color, whatever the option. `field(name)` writes `'$name'`.
  - Changed: a color option that computes a number or a boolean is an error, and the error says how to map it to colors.
  - Changed: an operation is an object with one key, its name: `{ add: [a, b] }`, `{ not: [a] }`, `{ is: ['$name', 'Austin'] }`.
  - Changed: `null` is a missing value.
  - Changed: one `when` chooses between values and colors alike.
  - Changed: `.colormap()` returns `Mapped`, like `.scale()`.
  - Changed: the layered layout's `flow` is renamed `direction`, so `flow` means only comets.
  - Removed: `{ op, args }`, `{ color }`, and `{ missing: true }`.
  - Removed: `Paint`, `PaintInput`, `Colormapped`, `Missing`, `color()`, and `missing()`.
  - Removed: bare strings as field names.
  - Removed: in Rust, converting a string or a `Name` into `Paint` or `Expr`.

## 0.2.1

### Patch Changes

- 5860c03: A view's first frame waits only for what draws its marks, a browser's first GPU is made while the runtime loads, pipelines compile only what their marks are and read, and the wasm is an eighth smaller. Diagrams look as modern as the rest: bordered blocks and groups that cast soft shadows, with corners, ports, and bends the theme sets.

  - Added: the theme's `outline`, `corner`, `portSize`, and `bend` set a diagram's block and group borders, their corners, its ports' width, and the radius of its wires' bends, which no longer follow `edgeSpacing`.
  - Added: `shadow: true` on a diagram's blocks and groups lays a soft shadow on the sheet, `shadow.lift` units below them, in the theme's shadow color.
  - Changed: a diagram's blocks and groups are bordered in the theme's `outline`, and a group draws no band behind its title. Corners, status rings, and ports' rings are part of the drawing and zoom with it; a status ring follows its marker's corners. A `block` marker's `corner` takes the theme's unless set.
  - Changed: a block makes room for the labels of its top and bottom ports, which did not show.
  - Changed: text is set in the system's sans-serif face unless the theme names one, where it was monospace.
  - Changed: a diagram grid's dots are a CSS pixel across on every screen.
  - Fixed: a mark ordered by `priority` draws the whole trace of the sampled field it traces; it drew nothing, and its plot fitted no values.
  - Fixed: a plot's y-axis label hangs from the top of the room above the plot, so a taller face no longer pushes it off the picture.
  - Fixed: a scene with two marks of one kind drawing one table asks for a `name`, as the option is called.
  - Changed: pipelines compile through one queue per GPU, the most urgent first: what frames draw with at once, their text as the browser's compile workers free up, then what transitions, lit rows, probes, and queries need, a few at a time. A view asks for its scene's as it is shown rather than at its first frame.
  - Changed: in a browser the GPU readies what nearly every scene draws with as its first view opens, once that view's frames have all they draw with; a GPU no view uses compiles nothing.
  - Changed: `loadLatkit()` asks for a GPU adapter as the runtime starts loading, so the browser's GPU process starts meanwhile, and makes the page's first GPU as it loads; the first `Gpu.create()` takes it.
  - Changed: a view's first frame draws its marks; labels, glyphs, and the overlay join once their pipelines landed, fading in as after any change. `complete` still waits for all of it.
  - Changed: a mark's channels compile for what they read: without fields of other tables, sampled fields, or `selected()`, `hovered()`, `pointer()`, and `zoom()`, their pipeline leaves each out. Fitted domains reduce in the channels' own pipeline.
  - Changed: label placement and the label draw compile for their mark's primitive, points, strokes, or triangles, as probes do: a quarter of the time for labels on points. Probes see each instance through one call, and placement passes no longer compile once per path.
  - Fixed: a plot's axes start below its title and subtitle, which drew over the plot.
  - Changed: the globe's atmosphere is a thin rim and a halo about as thick as the earth's air, where it was a wide glow over the ground and the marks near the globe's edge.
  - Changed: every transition eases through the settled state, so evaluating channels knows nothing of transitions.
  - Changed: expressions, sizes, labels, and colormaps are read where they are written, so error paths reach into expressions.
  - Changed: the wasm is 12% smaller (11% gzipped): sorts, name-keyed tables, and JSON reading each compile once, and URLs resolve without the `url` crate.

## 0.2.0

### Minor Changes

- 9e476cc: Patches are bytes written in TypeScript, datasets change in place, and types come from latkit's schema both ways.

  - Added: `Patch` without WebAssembly (`Patch.to(dataset)`, `fromBytes`, `stream`, `extend`), `Data.read` for latkit bytes and GeoJSON, `data.snapshot()`, queries' `ids`, `total`, and `contains`, `outputs.ts` (events, hits, stats, work, descriptions), and the documentation on Read the Docs.
  - Changed: `data.apply(patch)` changes the dataset in place; selections, row fits, `select` and `delete` events, and `neighbors` are row sets `{ data, table, ids }`; `Hit.mark` is the mark's name; picks, locations, and layouts reject with `timeout` past a deadline; `view.arrange()` answers patches that name their datasets; field kinds name geometries (`point`, `path`, `parts`, `polygons`); pictures and videos no longer make the pipelines only input needs.
  - Renamed: `put` to `replace`, a query's `where` to `filter`, vertices' `status` to `ring`, `rings` and (off plots) `trace` to `geometry`, `{ colormap: value, map }` to `{ colormap: map, value }`, `{ scale: value, range }` to `{ scale: [low, high], value }`, grid pitches to `{ lines: { pitch } }` and `{ dots: { pitch, snap } }`, the `'earth'` space to `'mercator'`, `forms.ts` to `inputs.ts`, and the error code `load` to `io`.
  - Removed: `geojson()` (`Data.read`), `Data.fromBytes`, patch handles and their `destroy()`, `removeTiles` (`removeData`), and bare numbers as row counts (`{ count }`).

- 9e476cc: Histories fetched in spans, and a frame's work follows what changed.

  - Added: time tiles. `view.setTiles(name, url)` opens a `frames.json` manifest, as `latkit tile` writes it, and fetches the spans of each sampled field's history its lines draw, at the detail they draw; a span still loading draws the coarser one above it.
  - Added: `Patch.frames(table, field, { level, first }, at, values)`, a run of a sampled field's entries, as a time tile holds them.
  - Changed: errors reading JSON (scenes, cameras, fits, queries, rows, budgets, shots) name the path to what could not be read, such as `scene.marks[2].vertices.color`.
  - Changed: a patch evaluates only the pages it wrote; a transition evaluates once and blends each frame; rows drawn through tiles keep their places while the camera moves, so only arriving rows upload; the views of a `Gpu` share its budget, none planning past it together.

- 9e476cc: Views open in the time of their slowest pipeline with no frame held back and compile a third fewer pipelines, a patch costs the rows it changed, an edit of a diagram derives only what it reaches, text sets its fields on the GPU, geometry no longer answers the pointer unless asked, and diagrams draw what focus and drags mean.

  - Added: `gpu.step(now)` draws one frame now, and from the first no animation frames are asked for: a harness steps every frame itself; `gpu.done()` resolves once the GPU finished what was submitted, every readback landed, and every pipeline asked for compiled; `gpu.landed()` once work a view waits on lands after the call, or a view asks for a frame; `view.wantsFrame`.
  - Added: `Work.late` counts pipelines made without being asked for ahead; `Waiting` names `compiling` while the pipelines a view draws with compile.
  - Changed: a view asks for every pipeline its scene can use the first time it draws, and the browser compiles them off its GPU thread, the largest first: what it draws with all at once, the view drawing once that landed and keeping its last frame until then; what lights rows, probes, and answers picks a few at a time while frames draw, those waiting until it landed. No frame waits on a compile and nothing compiles where it is first used; `complete` waits for all of it.
  - Changed: the wasm is built without wasm-opt: as small over the wire, and views open sooner, the browser no longer compiling one giant function before their first frame.
  - Changed: one probe program per kind of mark answers the hover, picks, boxes, and `locate`, a step at a time: a page compiles about a third fewer pipelines and finishes opening sooner.
  - Changed: `pick` lists every row within reach, however many: a mark with more than 1,024 asks again with room for all of them.
  - Changed: text sets its distance fields on the GPU, every run set in a frame at once: the host only rasterizes, so labels fill in faster.
  - Changed: an edit of the values a diagram sizes and places rows by derives only the rows it wrote and what they reach: their boxes, the groups around them, and the wires they move. A text column written over codes only the rows written.
  - Changed: appends one after another to a table, as a stream of frames makes, write as one change.
  - Changed: unless `pick` says, rows that are things answer the pointer (vertices, edges, faces, a plot's traces) and geometry does not (areas, and lines along paths: coasts, borders, roads); `pick: true` makes a map's states or cells answer it.
  - Changed: a fit in a diagram frames its sheet, blocks and wires, at once without a readback; labels place once a fit has moved the camera; a mark with no rows no longer holds a fit back.
  - Changed: a patch of values in a table drawn in part writes only the rows whose values changed.
  - Changed: a `drag` event's `position` is where the dragged row goes: where it was grabbed, moved as the pointer moved, snapped to a diagram's dots when its grid snaps.
  - Changed: error paths run through the mark's kind, as its JSON does: `marks[2].vertices.color`.
  - Changed: the expression node types are named for what they are: `FieldNode`, `ColorNode`, … `ColormapNode`; a size in units is `Units`, your own colormap `CustomColormap`.
  - Fixed: lines seen up close no longer break up or vanish: a stroke reaching behind the eye is cut at the near plane instead of dropped, and its pixels are placed on screen however differently deep its ends lie.
  - Fixed: a hovered or selected group glows about its border instead of hiding what it holds; a lit block keeps its ports on top; wires stop at the rims of ports, so arrowheads show; rounded wires draw no stray junction dots; an unlabeled block makes room for its ports; great circles settle while their vertices animate.
  - Fixed: ports and group borders read against light themes.

- 9e476cc: Establish the LATK v1 format and tighten the npm, Rust, and CLI release contracts.

  - LATK now has a versioned header, 64-bit absolute sample indexes, explicit stored detail levels, and bounded decoding. Regenerate earlier unversioned files and time tiles from their source data.
  - Added `latkit/core` for DOM-free builders and CPU-only Rust expressions, queries, and data loading.
  - Fixed video cancellation and output cleanup, arbitrary query field names, URL resolution, and shared GPU device callback ownership.
  - Public declarations and API/CLI references now come from checked sources. Packages include consistent MIT licensing and third-party notices.
  - Releases verify the installed npm tarball and both Cargo artifacts, and resume missing publications safely before tagging.

### Patch Changes

- 9e476cc: Keep font-atlas uploads in command order when several views render before one GPU submission.
  Multi-panel pictures and videos now retain every panel's titles, axis labels, and legends.
