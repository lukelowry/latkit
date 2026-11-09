# latkit

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
