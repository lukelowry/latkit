---
'latkit': minor
---

Labels are placed from each frame alone, with no fades. Where labels would overlap, the row drawn on top keeps its label.

- Added: a label's `text` takes a `when` that picks the text field or `null`. A row whose text is missing has no label, so `when(zoom().ge(6)).then(field('name')).otherwise(null)` labels rows from zoom 6 on.
- Changed: a row whose text is empty has no label, like a row whose text is missing.
- Changed: a label shows when its row is visible, its text is set, and the text fits, for example inside a block.
- Changed: labels beside or along their rows never overlap. Where they would, the row drawn on top wins, so a mark's `priority` decides.
- Changed: only labels that show need their texts, so a view of any size settles with as many texts as fit on screen.
- Changed: labels move with the camera in the frame it moves, keep showing while their mark gains texts, and never take another row's state when tiles change.
- Changed: when the text atlas is full of texts in view, it accepts no more until the view changes, instead of evicting texts it still shows.
- Changed: `'labels'` in `Waiting` means label texts are being read back or are not yet set.
- Removed: a label's `priority` and `max`, and label fades. A mark's `priority` orders its drawing, its thinning, and its labels.
