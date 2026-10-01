# Package responsibilities

| Package   | Owns                                                 |
| --------- | ---------------------------------------------------- |
| `model`   | Data contracts, native columns, validation           |
| `connect` | Transport, remote acquisitions, cancellation         |
| `gpu`     | Field preparation, text, colors, budgets, submission |
| `network` | Network geometry, cameras, picking                   |
| `monitor` | Trace geometry, axes, progressive history            |
| `video`   | Encoding and container output                        |
| `diagram` | Declaration-only API for a future renderer           |

Applications own data, canvases, storage, and GPU lifetimes.
Renderers borrow sources and GPU resources through the public contracts.
Several renderers can share one GPU owner.

Import package roots. Public types and methods are documented in the
[API reference](api/index.md), generated from source declarations.
See [lifecycle](lifecycle.md) for cleanup.
