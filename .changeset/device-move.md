---
'latkit': patch
---

A lost device moves each view to a new one as the same view, so nothing that waited on it is cancelled.

- Changed: when the device is lost, each view moves to the new device as the same view. Promises waiting on it (`fit`, `done`, `arrange`, `pick`, and other queries), its listeners, and pictures and videos drawing it carry over and answer there, where before they rejected as `cancelled`.
- Changed: a moved view keeps its laid-out places, camera, clock, and `stats`, so it lays out nothing again and its effects go on.
- Changed: latkit requests the new device once the page is in the foreground, as phones often lose the device in the background. If the page goes to the background before the device comes, latkit asks once more when it shows again.
- Changed: `gpu.work` counts the work of every device the GPU moved to.
- Changed: in Rust, `View::move_to(&gpu)` moves a view in place and can't fail.
- Removed: `View::rebuilt` in Rust, replaced by `View::move_to`.
- Fixed: a device given up for lack of memory no longer reports a `limit` error, since its views go on drawing on the new device.
- Fixed: a moved view reports its failures again only when they change.
