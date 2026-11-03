---
'latkit': minor
---

What every input does is set in one place, `controls.gestures`, with new gestures, and a cancelled or abandoned input never acts late.

- Added: `controls.gestures` sets what each input does: a drag with the `primary`, `secondary`, or `middle` button, the `wheel`, and two fingers that `pinch`, `twist`, or `slide`, each with any modifier keys held, as in `{ 'shift+primary': 'box', wheel: 'pan' }`. The actions are `pan`, `turn`, `tilt`, `zoom`, `box`, `zoomBox`, `scrub`, `connect`, and `none`. In Rust, `Gestures::with(key, action)` builds them.
- Added: new gestures. The wheel can pan, turn, or tilt, so a trackpad can scroll the map. A drag can tilt alone, or zoom to frame a box. Two fingers can twist to turn and slide to tilt.
- Added: the drag phase `cancel`. Its `position` and `patch` put the row back exactly as its fields held it when the drag started, however the camera moved and whatever grid drags snap to.
- Added: `Input::Blur`. Losing focus stops every gesture and the keys, and forgets the pointer until it moves again, so nothing asked for before lands and nothing stays hovered. A page's canvas sends it when it loses focus, and cancels a pointer it loses capture of.
- Changed: every button presses alike and does what its input says. A middle press never clicks, and a middle drag on a row of a draggable mark drags the row, as a primary drag does.
- Changed: a cancelled pan or turn no longer coasts, a cancelled drag reports `cancel` instead of `end`, and a cancelled press never clicks, selects, connects, or opens a menu.
- Changed: a probe asked for before the pointer left, or before a cancel, no longer sets the hover when its answer arrives.
- Changed: a canvas's `touch-action` follows its views: `none` when a finger dragging does something, `pan-x pan-y` when only two fingers do, and otherwise `manipulation`, so views that only inspect let the page scroll.
- Changed: pointer points allow for CSS transforms that scale the canvas, and a wheel that scrolls by pages scrolls by the canvas's size.
- Changed: where the camera cannot turn, in a diagram or on a plot, a turning drag pans.
- Removed: `controls.pan`, `zoom`, `turn`, `selectBox`, `connect`, and `scrub`, and the `Zoom` type. Each is now a `gestures` entry:
  - `pan: false` is `{ primary: 'none', middle: 'none', slide: 'none' }`.
  - `zoom: 'modifier'` is `{ wheel: 'none', 'control+wheel': 'zoom', 'meta+wheel': 'zoom' }`, and `zoom: 'off'` is `{ wheel: 'none', pinch: 'none' }`.
  - `turn: false` is `{ secondary: 'none', 'shift+primary': 'pan' }`.
  - `selectBox: true` is `{ 'shift+primary': 'box' }`, `connect: true` is `{ 'alt+primary': 'connect' }`, and `scrub: true` is `{ primary: 'scrub' }`.
