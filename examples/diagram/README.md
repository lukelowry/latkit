# Diagram studio

A local, interactive showcase of the unified diagram API. All scenes are synthetic.
The example implements a native Queryable source whose block ports reference signal
wires; the application accepts editing proposals and owns undo/redo.

```sh
pnpm install
pnpm --filter @latkit/diagram-example dev
```

Open http://127.0.0.1:5192. WebGPU requires a supported browser and graphics device.

- Control loop: ports, arrows, feedback, and one wire fanning out to two inputs.
- Grouped plants: nested groups, collapse/expand, proxy routing, and group movement.
- Shape atlas: rounded rectangles, rectangles, ellipses, and diamonds.
- Scale study: 1,024 blocks, 992 wires, zoom-dependent text, and live render statistics.
- Controls: layered/custom-grid layout, direction, orthogonal/straight/custom routing,
  tags, native color and width scales, status colors, live synthetic values, shared
  spotlight/custom shading, MSAA, snapping, labels, and reduced motion. Appearance controls
  include system/light/dark themes, density, title placement, corner radius, directional
  port markers, port labels, and adaptive detail. The inspector and controls can be hidden.
- Editing: add or drag in blocks; move, connect, reconnect, join a wire, rename,
  delete, select, additive marquee, inspect, reveal neighbors, undo, and redo. The example
  exposes background-drag and edge-panning preferences. Empty drops leave the wiring
  unchanged unless creation is enabled; dropping a reconnected input on empty space
  unplugs it. Arrangement and history can animate accepted positions.
- Export: a retained source and an independent renderer produce a fixed-time
  2048 × 1280 PNG through createRenderTarget and gpu.render.

The API panel shows the minimal integration. Source is split into graph.ts (domain
edits and history), source.ts (native data), presentation.ts (bindings), and main.ts
(the application). No legacy imports or adapter APIs are used.

```sh
pnpm --filter @latkit/diagram-example test
pnpm --filter @latkit/diagram-example build
node examples/diagram/tests/browser.mjs
```

The browser check expects the local dev server to be running. It exercises the
real controls, verifies every preset and export, and records desktop/mobile
screenshots in output/diagram-example/.
