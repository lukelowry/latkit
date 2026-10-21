# latkit

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
