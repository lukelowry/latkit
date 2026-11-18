---
'latkit': patch
---

Setting a view's scene or camera to what it already has changes nothing, so a page no longer needs to compare scenes before it sets them.

- Changed: setting `view.scene` to an equal scene no longer swaps scenes, emits a `waiting` event, or draws a frame.
- Changed: setting `view.camera` to the camera already placed, while no flight or fit moves it, no longer cancels anything. A plot camera with `y: null` keeps fitting its values as before.
- Changed: a setter that changes nothing draws no frame. Before, every setter drew one.
