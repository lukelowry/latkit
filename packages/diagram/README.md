# @latkit/diagram

Native model diagrams over the shared Latkit GPU pipeline. Components, ports,
hyperedges, groups, layout, routing, and picking share one measured geometry model.

```ts
import { createGpu, createCanvasView } from '@latkit/gpu';
import { createDiagram, attachDiagramInput } from '@latkit/diagram';

const gpu = await createGpu();
const diagram = createDiagram({
  gpu,
  data: {
    source: model,
    components: { Task: { labels: { field: 'name' } } },
    connections: { Dependency: { route: 'orthogonal', arrows: ['target'] } },
  },
  layout: { algorithm: 'layered', direction: 'right' },
});
const view = createCanvasView({ gpu, renderer: diagram, canvas, onError: console.error });
const detach = attachDiagramInput({ diagram, canvas, interaction: 'edit' });
view.request();

// Accept presentation movements; persist proposal.moves for stable IDs and undo.
diagram.on('move', ({ positions }) => {
  for (const [type, position] of Object.entries(positions))
    diagram.setComponent(type, { position });
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

Component bindings accept shared FieldInput values for position, size, color,
status, visibility, and shade. Positions and sizes are two-lane vectors; positions
can also bind separate x/y fields. Partial position overlays leave uncovered rows
under automatic placement. ColorScale and Scale support shared domains, including
sampled windows. Missing values use presentation defaults.

Labels are measured using the shared shaped text service. Font revisions participate
in the shared cache. maxWidth supports ellipsis or wrapping; maxCount bounds labels.
Component shapes are rounded, rectangle, ellipse, and diamond. Model ports support
side/order/label/color/status/marker overrides. Directional markers show port direction;
connected ports fill in while unwired ports remain hollow. Titles default to centered;
`labelPosition: 'header'` reserves a separate title row. Connections support straight or orthogonal
routes, arbitrary endpoint counts, role-based arrows, animated flow, junctions, and
tag appearance. A route strategy can implement the RouteStrategy interface.

Groups are presentation data, with optional parent groups. A component belongs to
one direct group. Moving a group proposes moves for all its descendant components. Collapsing a group projects external connections onto its boundary
and hides internal connections. Use setGroup to update a group.

Geometry, text sizes, layout gaps, and gridPitch are diagram units. Wire widths,
hit radii, port markers, focus outlines, pointer coordinates, pan deltas, and fit padding are CSS pixels.
Rounded corners use `cornerRadius` in diagram units. Node status remains visible alongside
hover and selection. Connection labels have pickable backdrops and share bounds with rendering.
Camera2D is shared with GPU; diagram defaults to y down. toDiagram applies snapping.
hitTest and locate use the last successfully submitted scene and camera.

## Layout and output

```ts
import { arrange } from '@latkit/diagram';

const positions = await arrange({
  data,
  layout: { algorithm: 'layered', direction: 'down', rankGap: 64, nodeGap: 24 },
  measureText: (input, options) => gpu.measureText(input, options),
  signal,
});
```

arrange does not acquire a GPU or DOM. Supply any compatible text measurement
function. It returns native indexed position fields without editing its sources.
Explicit positions constrain layout; manual layout requires every position.
Layered layout handles cycles and disconnected components deterministically.
Layered ranking keeps feedback cycles spread out, reserves label space, and uses bounded
crossing-reduction sweeps (`sweeps`, default 4). Custom strategies receive measured nodes,
ports, constraints, directed pairs, native hyperedges with roles and label sizes, and groups.
setLayout explicitly recomputes automatic placement; source replacements preserve
surviving automatic placements by stable identity. Pass `{ animate: true }` as the second
argument to `setData` or `setLayout` to interpolate accepted positions. Routing and picking
follow the displayed frame; the native data is read once per revision. Reduced motion,
large scenes (`animationMaxComponents`, default 512), resource budgets, or unroutable
intermediate positions settle immediately.

Use createRenderTarget and gpu.render for offscreen output, or createComposition
for multiple views. One diagram renderer represents one view; create separate
renderers for independent cameras. Retain every changing source and use fixed at
and timeMs values with completion: 'complete' for reproducible output.
setShade compiles before replacing the active shade; a failure preserves it.
Device loss follows the shared GPU lifecycle: recreate the GPU and renderers.

## Input

Edit mode adds move, marquee, connection/reconnection, and delete proposals.
Primary dragging on empty canvas selects; `backgroundDrag: 'pan'` changes this to pan.
Shift/Ctrl/Meta-click toggles selection once, and Shift-marquee extends selection.
Mouse and touch use independent drag thresholds, so clicking a port creates no wire. Space-drag or middle-drag pans; wheel zooms around the pointer.
Ports start wires; Alt-drag a component to connect at its boundary. Wired inputs propose endpoint replacement. Dropping on an
existing connection proposes a join; dropping in empty space proposes a free end.
The application assigns roles and decides whether to accept domain changes.
Escape, pointer cancellation, or data replacement clears previews. Two pointers pan and pinch zoom.
Long press opens a context menu.

Keyboard: Tab visits components and then leaves the canvas, Enter opens, Home fits, +/- zoom, arrow keys
pan or nudge selected components, Shift increases the step, Delete proposes removal.
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
  connectionRadiusPx: 18,
  autoPan: true,
  autoPanMarginPx: 32,
  autoPanSpeedPx: 480,
  canConnect: (proposal) => acceptsDomainConnection(proposal),
});
```

Native type/direction checks run before the optional synchronous `canConnect` policy.
A compatible target receives a snap preview; invalid targets cannot fall through to the
component body. Reconnection identifies the native source and exact endpoint ordinal.
The application may interpret a free-end proposal as cancellation, creation, or disconnection;
no domain object is created or removed by the renderer.

## Bounds and performance

Limits bound component/connection/endpoint counts, geometry, picking, route points,
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
  connectionWidthPx: 1.5,
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
