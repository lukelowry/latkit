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
side/order/label/color/status overrides. Connections support straight or orthogonal
routes, arbitrary endpoint counts, role-based arrows, animated flow, junctions, and
tag appearance. A route strategy can implement the RouteStrategy interface.

Groups are presentation data, with optional parent groups. A component belongs to
one direct group. Moving a group proposes moves for all its descendant components. Collapsing a group projects external connections onto its boundary
and hides internal connections. Use setGroup to update a group.

Geometry, text sizes, layout gaps, and gridPitch are diagram units. Wire widths,
hit radii, pointer coordinates, pan deltas, and fit padding are CSS pixels.
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
Custom layout strategies receive measured nodes, constraints, and directed pairs.
setLayout explicitly recomputes automatic placement; source replacements preserve
surviving automatic placements by stable identity.

Use createRenderTarget and gpu.render for offscreen output, or createComposition
for multiple views. One diagram renderer represents one view; create separate
renderers for independent cameras. Retain every changing source and use fixed at
and timeMs values with completion: 'complete' for reproducible output.
setShade compiles before replacing the active shade; a failure preserves it.
Device loss follows the shared GPU lifecycle: recreate the GPU and renderers.

## Input

Edit mode adds move, marquee (Shift-drag empty space), connection/reconnection,
and delete proposals. Space-drag or middle-drag pans; wheel zooms around the pointer.
Ports start wires; Alt-drag a component to connect at its boundary. Wired inputs propose endpoint replacement. Dropping on an
existing connection proposes a join; dropping in empty space proposes a free end.
The application assigns roles and decides whether to accept domain changes.
Escape, pointer cancellation, or data replacement clears previews. Two pointers pan and pinch zoom.
Long press opens a context menu.

Keyboard: Tab cycles components, Enter opens, Home fits, +/- zoom, arrow keys
pan or nudge selected components, Shift increases the step, Delete proposes removal.
Inspect mode preserves page scrolling. none installs no input.
motion: 'auto' follows reduced-motion preferences through the input attachment;
headless hosts can explicitly choose reduce or full.

## Bounds and performance

Limits bound component/connection/endpoint counts, geometry, picking, route points,
and preparation time. Native read caches use shared GPU budgets. Limits fail with
resource-limit rather than silently omitting data.

Camera and focus updates reuse scene geometry. Geometry pages use BufferData dirty
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
