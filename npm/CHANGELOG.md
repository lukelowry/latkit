# latkit

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
