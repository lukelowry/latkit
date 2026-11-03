---
'latkit': patch
---

Where depth varies, thin lines and small markers hide what lies behind them, and rows a selection dims never hide the selected ones.

- Fixed: where depth varies (a tilted camera, the globe, or raised vertices), a line thinner than a device pixel or a marker smaller than one now hides what lies behind it, so the nearest row shows whatever the order of the marks. Before, they hid nothing, and the row drawn last showed.
- Changed: an opaque row hides what lies behind it wherever its shape covers a pixel, never by how its edge is smoothed. A shape thinner than three device pixels also hides the pixels it partly covers, so it hides at least one. Translucent rows, including rows a selection dims and rows fading in or out, hide nothing, so the selected rows show over the dimmed ones. Dash gaps, comets, glows, shadows, status rings, an icon's clear pixels, and a custom marker's holes hide nothing either.
