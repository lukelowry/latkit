---
'@latkit/model': minor
---

Make native documents the entry point for opening and creating cases.

**Breaking:** `Model.document()` is removed, and the `Document` constructor no longer takes an
initial model. Native formats implement `Document.Format`, whose `open(bytes, signal?)` and
optional `create(name, signal?)` both return a `Document`. The format also supplies its id, label,
and filename extensions. Hosts own files, permissions, document lifetime, and saving.

Migrate native document constructors to `super()`, retain native state there, and implement the
protected `open` hook to capture an immutable model. Open a document through the format, then
call `document.model()` when a view or engine needs a snapshot. Editing and saving do not require
a model. Save current native bytes through `document.bytes()` or `session.bytes()`;
`model.bytes()` stays frozen with its snapshot.

The first model is now lazy. Concurrent readers share a capture, layout edits keep it, and
values or structure changes invalidate it. Failed captures can be retried without another edit;
cancelling one reader does not cancel shared work. Existing snapshots remain usable after edits.
`Document.Session`, `serveDocument`, and the wire contract are unchanged.
