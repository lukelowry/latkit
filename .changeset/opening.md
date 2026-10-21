---
'latkit': minor
---

Views open sooner, a patch costs the rows it changed, and diagrams draw what focus and drags mean.

- Changed: a view makes what its hover and intents need once its opening is over (a live plot need only have its first value range), or once a pointer is over it, a few a frame and drawing nothing while nothing changes, so those compiles no longer delay the readbacks its opening waits on and no frame waits long; its first frame makes only what it records.
- Changed: a fit in a diagram frames its sheet, blocks and wires, at once without a readback; labels place once a fit has moved the camera; a mark with no rows no longer holds a fit back.
- Changed: a patch of values in a table drawn in part writes only the rows whose values changed.
- Changed: a `drag` event's `position` is where the dragged row goes: where it was grabbed, moved as the pointer moved, snapped to a diagram's dots when its grid snaps.
- Changed: error paths run through the mark's kind, as its JSON does: `marks[2].vertices.color`.
- Changed: the expression node types are named for what they are: `FieldNode`, `ColorNode`, … `ColormapNode`; a size in units is `Units`, your own colormap `CustomColormap`.
- Fixed: a hovered or selected group glows about its border instead of hiding what it holds; a lit block keeps its ports on top; wires stop at the rims of ports, so arrowheads show; rounded wires draw no stray junction dots; an unlabeled block makes room for its ports; great circles settle while their vertices animate.
- Fixed: ports and group borders read against light themes.
