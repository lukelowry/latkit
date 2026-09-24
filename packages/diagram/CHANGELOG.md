# @latkit/diagram

## 0.1.0

### Minor Changes

- b2631b8: Add `@latkit/diagram`, a WebGPU block-diagram renderer and editor surface, and its netlist in `@latkit/model`.

  - Added: `Netlist` in `@latkit/model`, a block diagram's structure as columns: blocks, the ports each block owns, and the nets that join ports, with optional kinds, sides, tag-drawn nets, groups, keys, and labels. `validateNetlist` checks offsets, ranges, one driver and one kind per net, one net per port, unique keys, and label lengths, and throws an `Error` naming the first invalid field.
  - Added: `createDiagram(options)` in `@latkit/diagram`, a durable controller with the lifecycle of `Network` and `Monitor`: it takes neither a device nor a canvas, `attach` leases a device from the shared pool, `detach` keeps every state, a lost device is recovered in place, and `destroy` forgets the netlist and gives back the memory derived from it. `CHANNELS` and `OPTIONS` name what it speaks, and `validateOptions` checks an option patch before a device exists.
  - Added: automatic layout in layers along the signal flow with feedback returning underneath, one layout per unit shape, units packed six grid steps apart, right-angle wire routing with trunks, junctions, and arrows, and in-canvas text from a runtime glyph atlas. Every size derives from the `gridPitch` option, and blocks grow until no text collides.
  - Added: channels for block placement, block and net color and visibility, block and port status, dashes marching along nets, and shade values. The `blockPosition` channel places blocks, and a NaN pair hands a block back to its automatic position.
  - Added: `load` keeps every block whose `blockKey` survives where it was, with its placement and selection, lands new blocks beside what they connect to, and fades out removed ones. Every other channel clears.
  - Added: `fit(parts)` and `reveal(part, { neighbors })` frame some parts without redefining the fit view the `fit` event reports on.
  - Added: editing proposals. Under `interaction: 'edit'`, drawing a wire emits `connect`, dragging or nudging blocks emits `move`, and Delete emits `delete`; the diagram never edits its netlist, and a host loads the result it accepts.
  - Added: a `Shade` fragment hook for the block, port, wire, and group passes, reading `u.host` and `u.pointer_px`.
  - Added: `@latkit/diagram/layout` exports `arrange(netlist, { gridPitch })`, the same pure, deterministic layout without a device or a DOM, for a worker.

### Patch Changes

- Updated dependencies [b2631b8]
- Updated dependencies [b2631b8]
  - @latkit/model@0.6.0
  - @latkit/gpu@0.4.0
