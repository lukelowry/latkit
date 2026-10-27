---
'latkit': minor
---

Labels are placed from this frame alone: no state carried between frames, and no fades. Where labels would overlap, the label of the row drawn on top shows.

- Added: a label's `text` takes a `when` whose values are its text field or `null`. A row whose text is missing has no label, so `when(zoom().ge(6)).then(field('name')).otherwise(null)` labels rows from zoom 6 on.
- Changed: a row whose text is empty has no label, as one whose text is missing.
- Changed: a label shows wherever its row shows, its text is set, and it fits the room its row gives. Labels beside or along their rows never overlap: each claims the screen it covers, and the row drawn on top wins, so a mark's `priority` decides. Only labels that show need texts, so a view of any size settles with as many texts as fit on the screen. Labels move with the camera in the frame it moves, keep showing while their mark gains texts, and never inherit another row's state as tiles change.
- Changed: when the text atlas is full of texts in view, it takes no more until the view changes, instead of evicting texts it still shows.
- Changed: `Waiting`'s `labels` is label texts being read back or not yet set.
- Removed: a label's `priority` and `max`, and label fades. A mark's `priority` orders its drawing, its thinning, and its labels.
