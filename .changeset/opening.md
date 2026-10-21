---
'latkit': minor
---

Views open in the time of their slowest pipeline with no frame held back, a patch costs the rows it changed, geometry no longer answers the pointer unless asked, and diagrams draw what focus and drags mean.

- Added: `gpu.step(now)` draws one frame now, and from the first no animation frames are asked for: a harness steps every frame itself; `gpu.done()` resolves once the GPU finished what was submitted, every readback landed, and every pipeline asked for compiled; `gpu.landed()` once work a view waits on lands after the call, or a view asks for a frame; `view.wantsFrame`.
- Added: `Work.late` counts pipelines made without being asked for ahead; `Waiting` names `compiling` while the pipelines a view draws with compile.
- Changed: a view asks for every pipeline its scene can use the first time it draws, and the browser compiles them off its GPU thread, the largest first: what it draws with all at once, the view drawing once that landed and keeping its last frame until then; what lights rows, probes, and answers picks a few at a time while frames draw, those waiting until it landed. No frame waits on a compile and nothing compiles where it is first used; `complete` waits for all of it.
- Changed: the wasm is built without wasm-opt: as small over the wire, and views open sooner, the browser no longer compiling one giant function before their first frame.
- Changed: unless `pick` says, rows that are things answer the pointer (vertices, edges, faces, a plot's traces) and geometry does not (areas, and lines along paths: coasts, borders, roads); `pick: true` makes a map's states or cells answer it.
- Changed: a fit in a diagram frames its sheet, blocks and wires, at once without a readback; labels place once a fit has moved the camera; a mark with no rows no longer holds a fit back.
- Changed: a patch of values in a table drawn in part writes only the rows whose values changed.
- Changed: a `drag` event's `position` is where the dragged row goes: where it was grabbed, moved as the pointer moved, snapped to a diagram's dots when its grid snaps.
- Changed: error paths run through the mark's kind, as its JSON does: `marks[2].vertices.color`.
- Changed: the expression node types are named for what they are: `FieldNode`, `ColorNode`, … `ColormapNode`; a size in units is `Units`, your own colormap `CustomColormap`.
- Fixed: lines seen up close no longer break up or vanish: a stroke reaching behind the eye is cut at the near plane instead of dropped, and its pixels are placed on screen however differently deep its ends lie.
- Fixed: a hovered or selected group glows about its border instead of hiding what it holds; a lit block keeps its ports on top; wires stop at the rims of ports, so arrowheads show; rounded wires draw no stray junction dots; an unlabeled block makes room for its ports; great circles settle while their vertices animate.
- Fixed: ports and group borders read against light themes.
