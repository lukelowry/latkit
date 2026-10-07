---
'@latkit/model': minor
'@latkit/gpu': minor
'@latkit/network': minor
'@latkit/diagram': minor
'@latkit/monitor': minor
---

Every view answers the pointer with what it drew, and lights what is selected: selected and hovered items glow, a network draws them over the rest so a crowded region never covers them, and the rest can fade.

Added

- model: `itemKey(item, ...qualifiers)`, an item's identity as a string, which every view's identity builds on.
- gpu: `unselectedAlpha` for every view, which only a monitor had.
- gpu: `glowAlpha` in `kit.outputShader()` and `stroke_nearest` in `kit.strokeShader()` for renderers of your own, and a view's `detail` for hits that carry more than their item.

Changed

- gpu: `hoverColor` and `selectedColor` color a glow, whose alpha is its strength, and `hoverWidthPx` and `selectedWidthPx`, now 6 and 8, set how far it reaches. `'none'` glows in each item's own color.
- gpu: a click, double click, or menu supersedes one still finding its hits, and answers with what the presented frame draws, as `pick` does. Clicking again in place cycles only while the same items lie there. `select` with the items it holds does nothing.
- gpu: hover reports again when it finds the same item with other detail.
- gpu: `BufferData.touch` takes several ranges as one revision, so editing many places never makes a consumer upload the whole buffer.
- network: selected and hovered rows draw over everything but labels, lit by their glow, and the ends a focused edge joins draw over the rest. A curve's or path's glow never doubles where its pieces meet. Picks keep one hit per item, take `limit`, and break ties by what draws on top. An item from an earlier `Data` value has its neighbors.
- network: a selection or hover uploads only the focus words that change, far-apart runs each on their own, rather than every word between them.
- diagram: selected, hovered, and targeted items glow instead of taking a ring and a new color, and a block's ports stay lit with it. Selecting a row of another row space throws `conflict`, as in every view. Focus changes mark one revision.
- monitor: pick and hover hit a line anywhere it draws, steps and width included, one reading per row, and readings stand through playback while the drawn lines do. A reading selects its row wherever along the line. A selected trace glows, and a lone sample between gaps draws as a dot.

Removed

- monitor: its own `unselectedAlpha`, now every view's, and the selected traces' minimum width, which their glow replaces.
