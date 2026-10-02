# Package responsibilities

| Package   | Owns                                                        |
| --------- | ----------------------------------------------------------- |
| `model`   | Data contracts, native columns, validation                  |
| `connect` | Transport, remote acquisitions, cancellation                |
| `gpu`     | Views, field preparation, text, colors, budgets, submission |
| `network` | Network geometry, cameras, picking                          |
| `monitor` | Trace geometry, axes, progressive history                   |
| `diagram` | Diagram layout, routing, ports, editing proposals           |
| `video`   | Encoding and container output                               |

Applications own data, canvases, storage, and the GPU's lifetime. Views borrow sources and the GPU;
several views share one GPU.

Each package has one entry point, its root. A view is its own API: one config, one `set`, and the
methods every [view](views.md) shares. Renderer authors build on the `kit` namespace of
`@latkit/gpu`, which keeps that plumbing out of application code.
