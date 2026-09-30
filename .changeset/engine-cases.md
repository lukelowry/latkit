---
'@latkit/model': minor
'@latkit/port': minor
---

Make an engine the whole vendor: it keeps the vendor's cases and opens them for editing, so one port carries all of a vendor and a case never leaves the realm that holds it.

`Engine` takes `formats` (the `Document.Format`s its cases are in), `cases` (an `Engine.Cases` store: bytes by name, each read and written with a tag), and `idleBytes`. `engine.formats`, `engine.cases()`, `engine.open(name)`, `engine.create(name, { title } | { file })`, and `engine.save(name, version)` list, open, create, and keep cases. Every session on a case shares the one document the engine holds for it; a document with unsaved edits stays open until saved, and clean ones no session uses stay open within `idleBytes`, the least recently opened let go first. A save runs in the document's queue, so it keeps exactly the version it names, and refuses a version gone by with `DocumentConflict` and a case changed outside the engine with the store's error. `engine.close()` stops every recording it may still grow, closes every session on its cases, and resolves once its work has ended.

`Document.Session` is the one way a host edits a case, in the engine's realm or across a port, every call waiting its turn in the document's one queue. Sessions gain `close()`; `session.view.saved` is the version the engine last kept, and every session on a case hears a save through its `saved` event, whichever session saved and wherever each is. `session.model()` resolves with a `Model`. `Model` gains `close()`, which closes the source a model was opened from, such as a port connection. `Document.Format.create` takes the new case's title.

`serveEngine` serves each case a peer opens or creates as a session of its own on the engine's port (`document:<id>`), beside an `engine:cases` service; the studies offer carries the engine's formats. `connectEngine` resolves with an `Engine`, whose `open` and `create` answer with sessions on the peer's documents and whose `close()` stops what it follows and closes the connection. A model a session captures is recorded where it lives. A relay passes on the realm a borrowed model lives in, so it is recorded in place however many hops away. `connectModel` resolves with a `Model` and `connectRecording` with a `Recording`, each closed by its own `close`.

A document edit names its base revision, so one sent again after it landed conflicts rather than applying twice; the document wire no longer carries client identities, sequences, retained receipts, or per-edit command hashes.

**Migration:** `serveDocument`, `connectDocument`, and `connectDocument`'s `resume` are removed. Give the engine the format and a case store, serve the engine, and open cases with `engine.open(name)`; after a lost connection, open the case again and read its view. `Document.Snapshot` is removed: use `Model`, and call `model.close()` when finished. `Remote<Engine>` and `Remote<Model>` become `Engine` and `Model`; `engine.close()` now returns a promise. Upgrade both peers together: the engine and document protocols have changed.
