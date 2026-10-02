---
'@latkit/model': minor
'@latkit/connect': minor
---

Connect sizes publications for the wire, so producers never do.

Added

- `failure(code, message, details)` in model: the shared `Failure` constructor.
- `sliceSamples(column, row, rows, frame, frames)` in model: a strided view of sample cells.

Changed

- `publish` and monitor yields deliver in the fewest messages within the negotiated limits. A group that fits stays one atomic message; batches share a message while they fit, and a larger sample batch is cut only between whole frames, so each message appends in turn. A row batch must still fit one message. `protocol.preparePublication` remains the strict one-message primitive.
- `selectRows` resolves ID selections through a UTF-8 index of the ID pages instead of a retained string map.
- Connect raises model's typed `failure`; errors reported by a peer keep the peer's code.
