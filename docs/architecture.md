# Package responsibilities

| Package   | Owns                                                      |
| --------- | --------------------------------------------------------- |
| `model`   | Data contracts, native columns, bounded reads, validation |
| `connect` | Transport, remote acquisitions, cancellation              |
| `gpu`     | Views, layout, field uploads, text, colors, submission    |
| `network` | Network geometry, cameras, picking                        |
| `monitor` | Trace geometry, axes, progressive history                 |
| `diagram` | Diagram geometry, routing, ports, editing proposals       |
| `video`   | Encoding and container output                             |

Applications own data and its history, canvases, storage, and the GPU's lifetime. Views borrow
sources and the GPU; several views share one GPU.

Each package has one entry point, its root. A view is its own API: one config, one `set`, and the
methods every [view](views.md) shares. Renderer authors build on the `kit` namespace of
`@latkit/gpu`, which keeps that plumbing out of application code.

## Frames

Rendering separates the latest requested state from captured and submitted frames:

- Every renderer captures its inputs synchronously before any renderer prepares asynchronously.
  A composition captures every child before preparing any.
- A prepared frame commits what it shows only after the shared GPU submission succeeds. A discarded
  frame changes nothing.
- Invalidation schedules the latest state without cancelling a captured frame. Cancellation,
  detach, pause, and device loss stop work.

A frame is `presented` where the view shows itself: its canvas, a composition, or, for a view with
neither, its images. Video, and images of a view that presents elsewhere, are exports. They draw
the view's current state and advance none of it.

`kit.BaseView` carries this lifecycle for every built-in view. `kit.BaseItemView` adds the camera,
selection, picking, hover, and shades that network, monitor, and diagram share, so each supplies
only its geometry and gestures. A custom `kit.Renderer` keeps captured inputs stable until
`release`, and settles each prepared frame once, with `submitted` or `discard`.

## Work per frame

Work that depends on the data happens once and is reused, so a frame's CPU work stays constant in
the data's size.

- Reads, uploads, and `frame.memo` work are keyed by the immutable values they read. Moving `at`
  within one observation, or appending samples past it, reuses them.
- Text lays out once per key. Later frames move or hide only its anchors.
- Shades and eased motion advance through per-frame uniforms read in WGSL, not uploaded rows.

## Shared building blocks

Every per-row option is a [channel](topology-and-channels.md#channels). A type's channels bind to
the columns of one read. The CPU reads a row's channel as WGSL does, so picking and layout see what
the GPU draws.

Network and diagram share one graph, `kit.Graph`, and one [layout](views.md#layout), `kit.place`.
