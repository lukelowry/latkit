---
'latkit': minor
---

A label depends on its own row alone: no placement, no fades, and no label hides another.

- Added: a label's `text` takes a `when` whose values are its text field or `null`. A row whose text is missing has no label, so `when(zoom().ge(6)).then(field('name')).otherwise(null)` labels rows from zoom 6 on.
- Changed: a label shows wherever its row shows, its text is set, and it fits the room its row gives, in every space as in a diagram. Labels move with the camera in the frame it moves, keep showing while their mark gains texts, and never inherit another row's state as tiles change.
- Changed: `Waiting`'s `labels` is label texts being read back or not yet set.
- Removed: a label's `priority` and `max`, and label fades. A mark's `priority` still orders its drawing and thinning.
