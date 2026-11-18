---
'latkit': patch
---

Labels finish in browsers on Windows: a view with more labels than it sets in one frame no longer waits on `labels` forever, drawing every frame.

- Fixed: on Direct3D, which Chrome and Edge use on Windows, the pass that lists the texts labels need misread which texts were set once a view took more than one frame to set them, as with more than 48 labels in view or a font that rasterizes slowly. The view kept asking for the same texts, some labels never showed theirs, and `waiting` stayed `['labels']`.
- Changed: a label text asked for again after it was set no longer counts as progress. The view finishes, and the mark lists a failure saying some labels show no text.
- Changed: building latkit fails if a shader indexes a swizzle by a runtime value, which Direct3D reads wrong.
