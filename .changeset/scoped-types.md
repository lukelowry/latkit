---
'@latkit/model': minor
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/geography': minor
'@latkit/diagram': minor
'@latkit/monitor': minor
'@latkit/connect': minor
'@latkit/video': minor
---

Every package names its types under what they belong to, every view resolves its style one way, and lines on the globe stay on its surface.

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
