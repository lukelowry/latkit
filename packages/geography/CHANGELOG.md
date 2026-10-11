# @latkit/geography

## 0.1.0

### Minor Changes

- 37cad8c: A geography package draws the earth alone or beneath a network, and network edges curve over the globe and pick on every projection.

  Added

  - geography: `createGeography` draws the ground, areas, lines, and labels from Data, `geojson()`, or `tiles()`, flat or on a globe. Data prepares in workers, simplified alike along shared borders, and each frame draws what is in view at the detail it shows.
  - geography: `geojson()` reads a URL, as a string or a `URL`, as `tiles()` does; a Blob such as a local file; or bytes, gzipped or not; decoded and parsed in a worker.
  - geography: `tiles()` reads vector tiles from a PMTiles archive by URL, as a local file, or as bytes; a `{z}/{x}/{y}` template; or TileJSON. A feature with an id is one item in every tile and zoom that holds it. `info.schema` holds each layer's fields as the tiles' metadata declares them.
  - geography: tiles decode only the layers and properties records read, and every tile carries each field read, typed as declared, so a name no feature of a tile holds reads as empty there instead of failing the frame. Tiles share one schema, so what reads them plans once.
  - geography: a record whose `visible` is false draws its labels alone; nothing of it hovers or picks.
  - geography: lines take `dash` and `flowPx` as network edges do, with `flowColor` and `flowSpacingPx`.
  - network: `ground` draws a view beneath the graph, such as a geography, in its pass. Its sun lights the graph, and a gesture the graph leaves reaches it unless its `input` is `'none'`.
  - network: the `mercator` projection, for geographic data.
  - network: edges curve over the globe on the GPU, in as many pieces as the screen needs; geodesics also draw on flat and mercator maps.
  - gpu: `Labels` takes `fontSizePx` and `repeatSpacingPx`, for every view that labels in CSS pixels.
  - gpu: `ProjectedCamera`; `kit.Projector` and `kit.projectionShader`, one projection in TypeScript and WGSL; `kit.layerOf` and the `Layer` types, which draw one view beneath another; `stroke_comet` in `kit.strokeShader`; and `BaseView.paused`, called as a view pauses.
  - model: `Work` takes a `Work.Priority`; `'background'` work yields to everything else.
  - model: a `geographic` field may hold lists of positions, as polylines, and lists of those, as rings.

  Changed

  - network: `grid` and `gridColor` draw lines of the data's x and y beneath the graph, as before longitude and latitude for geographic data and now also a plain plane's, the nicest step at least `gridMinSpacingPx` apart; over a ground, the ground's own `grid` draws instead.
  - network: an edge's `route` defaults to `geodesic` on the globe and `straight` on flat maps.
  - network: geographic positions start on the mercator plane, as a geography does.
  - network: picking and hover query hit-test indexes on every projection, built in the background once the positions and the camera hold still. Only rows raised by `z` scan.
  - network: a dashed edge picks along its whole length, gaps included.
  - network: a camera move uploads no draw parameters, and a frame draws edges in one render pass.
  - gpu: `ItemView.Config` holds no `source`; each view's config declares its own.

  Removed

  - network: `paths`, `PathOptions`, and `LineOptions`. Draw lines that join no vertices as a geography's `lines`.
  - network: `earthAxis`, `surfaceColor`, `daylight`, `sunTime`, `nightFloor`, `surfaceNightFloor`, `terminatorWidth`, `pathColor`, and `pathWidthPx`. Set `earthAxis`, `surfaceColor`, `daylight` (a time, `'now'`, or `false`), `nightFloor`, and `terminatorWidth` on a geography, and its `grid` for lines of longitude and latitude.
  - network: `Camera` and `Projection`. Import `ProjectedCamera` from `@latkit/gpu`.
  - network: `NetworkLabels`. Its `fontSizePx` and `repeatSpacingPx` are `Labels` options now.

- 37cad8c: Every package names its types under what they belong to, every view resolves its style one way, and lines on the globe stay on its surface.

  Added

  - gpu: `kit.ProjectedView`, the camera network and geography share: fitting from `fitPitch` and `fitBearing`, turning, and orbiting at `orbitRate`.
  - gpu: `kit.resolveStyle`, the one style resolver every view uses, and `kit.LineStyle`, `kit.ProjectedStyle`, and `kit.GridStyle` with their defaults.
  - gpu: `kit.gridLines` and `kit.gridShader`, the grid network and geography draw, and `projection_ground_point` in `kit.projectionShader`, the ground under a pixel.
  - gpu: `kit.Feedback`, words the GPU writes read back without stalling a frame.
  - geography: `orbit`, `fitPitch`, `fitBearing`, `orbitRate`, `labelHaloPx`, `grid`, `gridColor`, and `gridMinSpacingPx`; arrows pan, and Shift and the arrows turn.
  - network: `vertexMinRadiusPx`. Zoomed out, markers shrink to stay a quarter of an edge apart, down to it.
  - diagram: `dashPeriodPx`, `flowColor`, and `flowSpacingPx`.
  - model: `sampleRuns`, the runs of recorded frames a window covers.

  Changed

  - every package: types live under a root, so one import brings them all: `Network.Config`, `Network.VertexOptions`, `Geography.LineOptions`, `Tiles.Options`, `Diagram.Camera`, `Diagram.GroupOptions` (was `Group`), `Monitor.TraceOptions` (was `Trace`), `Connection.Options`; `View.Config`, `ItemView.Style`, `ItemView.ContextMenu`, `ProjectedCamera.Projection`, `Layout` (was `LayoutOptions`), `Layout.Positions`, `Scale.Color`, `Channel.Color`, `Colormap.Name`, `Marker.Image`, `Gpu.Options`; `Column.Numeric`, `Index.Rows` (was `RowAxis`), `Index.Selection`, `Data.Batch`, `Data.Pages`, `Data.Location` (was `SampleLocation`), `Schema.Field`, `Schema.FieldType` (was `DataType`), `Query.Samples`, `Query.Selection` (was `FieldSelection`), `Query.Window`, `Block.Rows`, `Block.Fields`, `Reader.Scope`, `Reader.Dependencies` (was `ReadRecord`), `Memory.Entry`, `FieldInput.Binding`, `Failure.Code`, `Model.Publication`, `Command.Context`, `Command.Input` (was `InputValue`).
  - model, gpu: a memory budget bounds what the pool keeps, never what views draw. To make room the pool lets go of what no one holds, least recently used first, and what is held runs over the budget until it is let go, so no frame fails with `CPU or entry budget exceeded by held results`, a GPU budget, or a staging budget.
  - gpu: text holds the atlas pages it shapes onto, so no page goes while a frame still needs it.
  - gpu: a view drawn beneath another takes only the input its own `input` allows: under `'none'` it hovers, selects, and reports nothing, and searches for no hover. Over neither view's items, the host reports a menu itself, and a click on the host's items clears the selection beneath.
  - diagram: `Diagram.Style` takes `grid`, `gridColor`, and `gridMinSpacingPx` from `kit.GridStyle`.
  - model: a sampled field read at a coordinate before a row's first observation reads that row as absent, instead of failing with `Query did not cover the requested draw rows`.
  - network, geography: a line on the globe draws on the surface under each of its pixels, so no curve sinks into the earth at any pitch, and its pieces no longer dim each other where they meet.
  - network: a transition the GPU budget has no room for steps instead of easing.
  - network: each curve's pool of pieces holds what it asked for the frame before, read back from the GPU; a curve asking for more draws again at once.
  - diagram: flowing wires carry comets, as network and geography lines do; under reduced motion they hold still.
  - geography: hover and selection glow past a line by `hoverWidthPx` and `selectedWidthPx`.
  - monitor: the hovered reading draws a dot in `hoverColor`, glowing by `hoverWidthPx`.
  - monitor: history over frames never recorded draws each run of frames apart, instead of failing.
  - gpu: `pulse` and `spotlight` take an RGBA `color`; its alpha is how far they tint.
  - every view: options of one kind check alike: a color is RGBA, a boolean a boolean, and a number finite and not negative unless it says otherwise. `fitBearing` and `orbitRate` may be negative, and `fitPitch` is at most 80.
  - network, geography: an orbit holds still under reduced motion, including one that began before.

  Removed

  - gpu: `viewStyle` and the text layout types at the top level; use `kit.viewStyle` and `kit.TextLayout`.
  - gpu: `strength` of `pulse` and `spotlight`; set the color's alpha.
  - model: `sameItem`; compare `itemKey`s. `ReadResult`; use `Block.Of`. `RequestOptions`, `Version`, `Scalar`, and `Value`.

### Patch Changes

- Updated dependencies [37cad8c]
- Updated dependencies [37cad8c]
  - @latkit/gpu@0.19.0
  - @latkit/model@4.2.0
