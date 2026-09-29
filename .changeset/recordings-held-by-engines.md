---
'@latkit/model': minor
'@latkit/port': minor
---

Keep recording samples where their engine runs, using a separate `Series.Store` per recording (in memory by default). Connected engines follow recording metadata with `Recording.follow` and fetch sample windows on demand. Call `recording.close()` when finished to release its store or remote recording; `stop()` keeps recorded samples available. Closing an engine connection releases all recordings it serves to that peer.

**Migration:** `Engine.record(model, input, recorder)` has been removed. Engine adapters that follow recordings held elsewhere should override the protected `begin` method and return a `Recording`. Custom stores provide `put`, `get`, `close`, and optional `ready` backpressure; failed writes leave the last committed frame and ranges intact.

**Migration:** `Engine.File` now exposes `{ name, size, slice, stream }` instead of `{ name, bytes }`. Pass a browser `File` directly, or adapt existing bytes with `new File([bytes], name)`. Across a port, files are read in bounded chunks as requested, preserving file slice offsets. Upgrade both engine peers together: the engine recording and file protocols have changed.

Expose `document.version` as the version shared by its sessions. Document implementations must replace changed schematic parts, retain unchanged parts by identity, and retain the palette array until it changes; the document service now uses those identities when sending updates.

Keep a recording's opening abort signal scoped to its first change, and discard pending source changes after the recording stops.
