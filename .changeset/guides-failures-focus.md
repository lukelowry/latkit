---
'latkit': minor
---

Titles, legends, and axes lay out around the marks, failures are state instead of errors, and views share their selection and hover.

- Added: `place` on a `title` and on each `legend`: a side (`'top'`, `'right'`, `'bottom'`, `'left'`) takes room from the marks, so fits frame clear of it and marks stay out of it, or a corner (`'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`) sits over the marks on a backdrop. A plot defaults to the top and right, other spaces to the top-left and bottom-right corners. A title and legends in one place stack and wrap into another row or column instead of running off the view. A legend's bar stands upright on the left and right.
- Added: `unit` on a plot `Axis` and on a `legend`, written after the last tick's value, as in `" s"` or `" pu"`.
- Added: a `failures` change event with every failure, and `Scene::failures(sources)` in Rust, which lists what a view would report.
- Added: `view.hovered` can be set to any row, and `related()` reads whether a row is one reference from a selected or hovered row.
- Changed: `title` takes a text or `{ text, subtitle, place }`, and `legend` a title or `{ title, unit, place }`.
- Changed: an option that can't be read, or that the scene can't use, draws as if unset and is listed in `failures`, like an option that doesn't fit the data. Only a scene whose space, marks, or a mark's dataset and table can't be read throws. A second mark with an earlier mark's key draws nothing.
- Changed: `error` events report only what stops a view drawing, and pictures and videos fail only on those. A picture draws a view with failures as the view does.
- Changed: the selection keeps rows that no mark of the view draws, so views can share it. Rows one reference from a selected or hovered row, through any reference field, such as a bus's branches and machines, draw on top, and a selection keeps them bright while the rest dim. They no longer glow, which only selected and hovered rows do. A hover change costs time in proportion to the hovered row's references, not the selection.
- Changed: `view.hovered` is a row. The `hovered` event still carries the hit, and fires as the pointer moves between samples of one traced line.
- Changed: titles, legends, and axes space themselves in ems of the theme's text size, so views that share a theme line up, and a plot's axes keep the same padding from the view's edges.
- Changed: titles, legends, and axis labels align their text by its line box, without the padding around its raster.
- Changed: in Rust, `View::new` and `set_scene` no longer fail, `View::hovered` returns a `Row`, and `Raster` has a `line_box`.
- Removed: `subtitle`, now part of `title`, and `Scene::validate` in Rust.
- Fixed: a y-axis title no longer overlaps the top tick's label.
- Fixed: text set before a web font loads is set again once it loads.
