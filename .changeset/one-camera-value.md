---
'@latkit/network': minor
'@latkit/diagram': minor
'@latkit/monitor': minor
---

Give each view one camera value a host keeps and restores, and one pointer contract.

- Added: `getCamera()` and `setCamera(camera, animate?)` on `Network`: the camera as one value, `{ projection, centerX, centerY, pitch, bearing, scale, fit }`, where `scale` is CSS pixels per world unit at the view anchor and `fit` says it follows the fit view. `setCamera` moves it in one step, a projection switch keeping the pose it is given, and returns false for a projection the topology cannot show; before a topology loads only a projection applies, and while no canvas has a size the placement waits for the first frame that does.
- Added: `getCamera()` and `setCamera(camera, animate?)` on `Diagram`, the same value without a projection: `{ centerX, centerY, scale, fit }`, `fit: true` fitting the diagram.
- Added: a `contextmenu` event on `Monitor`, as the network and the diagram emit: the native menu suppressed, and the sample under the pointer, resolved against the series shown when it was asked, or for the keyboard the sample last hovered.
- Changed: `@latkit/monitor` selects on the primary button alone.
- Removed: `getPose`, `setPose`, `setProjection`, and the `Pose` type from `@latkit/network`, for the camera value; a projection the topology cannot show no longer falls back, since `projections` says ahead which it can. `projection` stays, naming the projection shown before a canvas has a size.
- Removed: `getPose`, `setPose`, and the `Pose` type from `@latkit/diagram`, for the camera value, whose `scale` is the pose's `zoom`.
