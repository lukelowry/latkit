---
'latkit': minor
---

Views can follow a `Playhead`, which plays the axis coordinate they show without the page setting `at` every frame.

- Added: `Playhead`, an axis coordinate that moves at a rate while it plays, within an optional span that it stops at or loops around. Views that follow one show the same coordinate in the same frame. A frame moves it at most a quarter second's worth, so a page that stalls or is hidden resumes where it was.
- Added: `view.playhead` and the `playhead` option of `View.create`. Scrubbing a view that follows a playhead moves the playhead, and setting the view's `at` does too.
- Added: in Rust, `web::Playhead` and `PageView::follow`.
