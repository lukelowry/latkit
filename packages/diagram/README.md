# @latkit/diagram

Native model diagrams over the shared Latkit GPU pipeline. Vertices, ports,
edges, groups, layout, routing, and picking share one measured geometry model.

```ts
import { createGpu, createCanvasView } from '@latkit/gpu';
import { createDiagram, attachDiagramInput } from '@latkit/diagram';

const gpu = await createGpu();
const diagram = createDiagram({
  gpu,
  data: {
    source: model,
    vertices: { Task: { labels: { field: 'name' } } },
    edges: { Dependency: { ends: ['from', 'to'], route: 'orthogonal', arrows: true } },
  },
  layout: { algorithm: 'layered', direction: 'right' },
});
const view = createCanvasView({ gpu, renderer: diagram, canvas, onError: console.error });
const detach = attachDiagramInput({ diagram, canvas, interaction: 'edit' });
view.request();

// Accept presentation movements; persist proposal.moves for stable IDs and undo.
diagram.on('move', ({ positions }) => {
  for (const [type, position] of Object.entries(positions)) diagram.setVertex(type, { position });
});

// On teardown:
detach();
view.destroy();
diagram.destroy();
gpu.destroy();
```

Sources and the GPU are borrowed. The application owns domain edits and undo.
The diagram emits connect, move, delete, select, open, hover, and contextmenu events.
Physical data hits include their source, Index, and row; stable item references use
kind/type/id (and port name). Never reuse a position field across incompatible row
indexes: persist stable movement IDs and re-key positions after replacement.

## Data and geometry

Topology is the model's reference fields. An edge with `ends` joins the two vertices
its reference fields name. Without `ends` the edge type is a net: each row joins the
ports whose references name it, so one output can fan out to many inputs. A vertex's
reference fields that name a drawn net are its ports, oriented by the field's
`direction`.

Vertex bindings accept shared FieldInput values for position, size, color,
status, visibility, and shade. Positions and sizes are two-lane vectors; positions
can also bind separate x/y fields. Partial position overlays leave uncovered rows
under automatic placement. ColorScale and Scale support shared domains, including
sampled windows. Missing values use presentation defaults.

Labels are measured using the shared shaped text service. Font revisions participate
in the shared cache. maxWidth supports ellipsis or wrapping; maxCount bounds labels.
Vertex shapes are rounded, rectangle, ellipse, and diamond. Ports support
side/order/label/color/status/marker overrides, keyed by reference field. Directional markers show port direction;
connected ports fill in while unwired ports remain hollow. Titles default to centered;
`labelPosition: 'header'` reserves a separate title row. Edges support straight or orthogonal
routes, any number of ends, arrows where flow arrives, animated flow, junctions, and
tag appearance. A route strategy can implement the RouteStrategy interface.

Groups are presentation data, with optional parent groups. A vertex belongs to
one direct group. Moving a group proposes moves for all its descendant vertices. Collapsing a group projects external edges onto its boundary
and hides internal edges. Use setGroup to update a group.

Geometry, text sizes, layout gaps, and gridPitch are diagram units. Wire widths,
hit radii, port markers, focus outlines, pointer coordinates, pan deltas, and fit padding are CSS pixels.
Rounded corners use `cornerRadius` in diagram units. Vertex status remains visible alongside
hover and selection. Edge labels have pickable backdrops and share bounds with rendering.
Camera2D is shared with GPU; diagram defaults to y down. toDiagram applies snapping.
hitTest and locate use the last successfully submitted scene and camera.

## Layout and output

```ts
import { arrange } from '@latkit/diagram';

const positions = await arrange({
  data,
  layout: { algorithm: 'layered', direction: 'down', rankGap: 64, vertexGap: 24 },
  measureText: (input, options) => gpu.measureText(input, options),
  signal,
});
```

arrange does not acquire a GPU or DOM. Supply any compatible text measurement
function. It returns native indexed position fields without editing its sources.
Explicit positions constrain layout; manual layout requires every position.
Layered layout handles cycles and disconnected subgraphs deterministically.
Layered ranking keeps feedback cycles spread out, reserves label space, and uses bounded
crossing-reduction sweeps (`sweeps`, default 4). Custom strategies receive measured vertices,
ports, constraints, directed pairs, edges with their ends' directions and label sizes, and groups.
setLayout explicitly recomputes automatic placement; source replacements preserve
surviving automatic placements by stable identity. Pass `{ animate: true }` as the second
argument to `setData` or `setLayout` to interpolate accepted positions. Routing and picking
follow the displayed frame; the native data is read once per revision. Reduced motion,
large scenes (`animationMaxVertices`, default 512), resource budgets, or unroutable
intermediate positions settle immediately.

Use createRenderTarget and gpu.render for offscreen output, or createComposition
for multiple views. One diagram renderer represents one view; create separate
renderers for independent cameras. Retain every changing source and use fixed at
and timeMs values with completion: 'complete' for reproducible output.
setShade compiles before replacing the active shade; a failure preserves it.
Device loss follows the shared GPU lifecycle: recreate the GPU and renderers.

## Input

Edit mode adds move, marquee, connect/reconnect, and delete proposals.
Primary dragging on empty canvas selects; `backgroundDrag: 'pan'` changes this to pan.
Shift/Ctrl/Meta-click toggles selection once, and Shift-marquee extends selection.
Mouse and touch use independent drag thresholds, so clicking a port creates no wire. Space-drag or middle-drag pans; wheel zooms around the pointer.
Ports start wires; Alt-drag a vertex to connect at its boundary. Dragging a wired input
proposes moving it off its net. Dropping on an existing net proposes a join; dropping in
empty space proposes a free end. The application decides which references change.
Escape, pointer cancellation, or data replacement clears previews. Two pointers pan and pinch zoom.
Long press opens a context menu.

Keyboard: Tab visits vertices and then leaves the canvas, Enter opens, Home fits, +/- zoom, arrow keys
pan or nudge selected vertices, Shift increases the step, Delete proposes removal.
Inspect mode preserves page scrolling. none installs no input.
motion: 'auto' follows reduced-motion preferences through the input attachment;
headless hosts can explicitly choose reduce or full.

```ts
const detach = attachDiagramInput({
  diagram,
  canvas,
  interaction: 'edit',
  backgroundDrag: 'select',
  dragThresholdPx: 4,
  touchDragThresholdPx: 8,
  connectRadiusPx: 18,
  autoPan: true,
  autoPanMarginPx: 32,
  autoPanSpeedPx: 480,
  canConnect: (proposal) => acceptsDomainConnection(proposal),
});
```

Native checks run before the optional synchronous `canConnect` policy: two ports wire
together only through a net type both reference, never input to input. A compatible
target receives a snap preview; invalid targets cannot fall through to the vertex body.
Reconnection starts from the net's source and names the port leaving it.
The application may interpret a free-end proposal as cancellation, creation, or disconnection;
no domain object is created or removed by the renderer.

## Bounds and performance

Limits bound vertex/edge/end counts, geometry, picking, route points,
and preparation time. Native read caches use shared GPU budgets. Limits fail with
resource-limit rather than silently omitting data.

Camera, focus, and uniform-only style changes reuse scene geometry. Adaptive grid spacing
stays aligned while panning. `detail: 'auto'` fades port markers and arrows at distant zoom;
`detail: 'full'` keeps them visible. Invisible port markers do not intercept body selection.

```ts
diagram.setOptions({
  cornerRadius: 8,
  outlineWidthPx: 1,
  selectionWidthPx: 2,
  hoverWidthPx: 3,
  portMarker: 'directional', // also circle or diamond; per-port overrides supported
  portSizePx: 8,
  portFontSizePx: 11,
  portLabels: true,
  edgeWidthPx: 1.5,
  gridMinSpacingPx: 12,
  detail: 'auto',
});
```

Geometry pages use BufferData dirty
ranges, and text uses independent anchor buffers. Local movement reuses unaffected
routes and does not re-query model data during a drag. All query iterators are
consumed or closed. Candidate scenes become pickable only after successful frame
submission, including when composed with other renderers.

Run pnpm --filter @latkit/diagram test for CPU/lifecycle checks and
pnpm --filter @latkit/diagram test:browser for actual WebGPU, input, composition,
and pixel readback checks. The browser fixture writes output/diagram-browser.json
and output/playwright/diagram.png.

Run the interactive [Diagram studio](../../examples/diagram/README.md) with
`pnpm --filter @latkit/diagram-example dev`, then open http://127.0.0.1:5192.
