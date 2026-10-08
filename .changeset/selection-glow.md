---
'@latkit/model': minor
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/diagram': minor
'@latkit/monitor': minor
---

Selected and hovered items glow in every view, picks answer with what the frame draws, and a network draws its selection over the rest, so a crowded region never hides it.

Added

- model: `itemKey(item, ...qualifiers)`, the identity every view's selection builds on.
- gpu: `unselectedAlpha` for every view, `glowAlpha` and `stroke_nearest` in the kit shaders, and a view's `detail` hook.

Changed

- gpu: `hoverColor` and `selectedColor` color a glow, and `hoverWidthPx` and `selectedWidthPx`, now 6 and 8, set its reach. `'none'` glows in each item's own color.
- gpu: clicks, double clicks, and menus answer with what the presented frame draws; a later one supersedes one still finding its hits. Clicking again in place cycles only while the same items lie there.
- gpu: `BufferData.touch` takes several ranges as one revision.
- network: selected and hovered rows, and the ends of a focused edge, draw over everything but labels. Picks keep one hit per item and take `limit`.
- diagram: selected, hovered, and targeted items glow. Selecting a row of another row space throws `conflict`.
- monitor: pick and hover hit a line anywhere it draws, one reading per row, and a reading selects its row. A selected trace glows, and a lone sample between gaps draws as a dot.

Removed

- monitor: its own `unselectedAlpha`, now every view's, and the selected traces' minimum width.
