# @latkit/diagram example

A Vite example for the published shape of [`@latkit/diagram`](../../packages/diagram): a small
editing host around one diagram controller. It draws control diagrams of power plants modeled on
GridKit's PhasorDynamics classes (GENROU, GENCLS, TGOV1, IEEET1, IEEEST, REGCA, REECB, REPCA, with
the port names and directions of their "Model Ports" tables), with each bus drawn as a tag.

## Run

Requires a browser with WebGPU support.

```sh
pnpm install
pnpm --filter @latkit/diagram-example dev
```

The dev script builds `@latkit/model`, `@latkit/colormaps`, `@latkit/gpu`, and `@latkit/diagram`
first, then starts Vite at http://127.0.0.1:5194.

## What it shows

- **Scenes:** one TwoArea generator unit, Kundur's two-area system (four units on four buses), a
  WECC-style mix of 64 plants, and a scale scene of 13,100 plants (about 36k blocks). Block keys
  start with the scene's id, so no block survives a switch and each scene loads freshly arranged.
- **The proposal flow:** the diagram never edits its netlist. `connect`, `move`, and `delete`
  events, and classes dropped from the palette at `toDiagram()`, become edits of an in-memory
  document (`src/document.ts`) shaped like a GridKit case: devices whose ports name a signal or a
  bus. An accepted edit loads the new netlist with `{ fit: false }` and writes the document's
  placements to `blockPosition` (a load carries surviving blocks' placements by key, but not those
  of blocks it adds or of an unchanged netlist); a refused one writes the placements back and says
  why in the status bar.
- **GridKit-like wiring rules:** the driver is the `out` port; two outputs never share a signal;
  two unwired inputs need an output first; an input already reading another signal is refused
  until it is disconnected. Picking up a wired input's wire and dropping it elsewhere is one step
  (disconnect, then connect); dropping it on empty canvas disconnects it.
- **Undo and redo:** a stack of immutable documents, with buttons and Ctrl+Z / Ctrl+Shift+Z
  (Ctrl+Y also redoes). Undoing a move hands the block back to its automatic spot.
- **Arrange:** clears the document's placements (an undoable step) and recomputes the automatic
  layout, eased.
- **Simulate:** a stand-in for playback that colors every signal by a ringing deviation in
  `[-1, 1]` through `netColor` and marches dashes along it with `netFlow`.
- **Controls:** interaction mode, routing, grid, snap, labels, arrows, junctions, motion,
  colormap, and fit. Light and dark follow `prefers-color-scheme`, mapped to the diagram's color
  options; the canvas is transparent over the page's backdrop.
- **Status bar:** hover, selection, the last proposal or refusal, and the frames per second the
  diagram renders (counted by an identity shade's `tick`; `idle` when nothing redraws).

The console has a `diagram` handle, and logs load timings per scene.

## Build

```sh
pnpm --filter @latkit/diagram-example build
```

The example depends on its packages through workspace links, so it consumes the same `dist`
entrypoints a downstream app would use.
