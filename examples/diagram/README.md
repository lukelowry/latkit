# Diagram studio

An interactive showcase of the diagram view on synthetic scenes. The application owns immutable
`Data`, accepts the view's edit proposals, and keeps undo and redo.

```sh
pnpm install
pnpm --filter @latkit/diagram-example dev
```

Open http://127.0.0.1:5192. The dev command builds the packages first.

- Control loop: ports, arrows, feedback, and one wire fanning out to two inputs.
- Grouped plants: nested groups, collapse and expand, and wires routed through group boundaries.
- Shape atlas: rounded rectangles, rectangles, ellipses, and diamonds.
- Scale study: 1,024 blocks and live render statistics.

Controls switch layout, routing, scales, shading, themes, and labels. Edit mode adds, moves,
connects, reconnects, renames, and deletes blocks. Export renders a 2048 × 1280 PNG from an
offscreen diagram with `image()`.

```sh
pnpm --filter @latkit/diagram-example test
node examples/diagram/tests/browser.mjs
```

The browser check needs the dev server running. It drives every preset and the export, and saves
desktop and mobile screenshots to `output/diagram-example/`.
