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

Rendering separates the latest requested state from captured and submitted frames. Every renderer
captures its inputs synchronously before any renderer prepares asynchronously. A prepared candidate
encodes commands and commits its visible state only after the shared GPU submission succeeds.
Discarding a candidate does not acknowledge observations. Ordinary invalidation schedules the
latest state; it does not cancel a valid captured frame. Explicit cancellation, detach, pause, and
device loss still stop work.

Network, monitor, diagram, composition, images, and video use this same lifecycle. Canvas views
coalesce requests while preparation runs and admit the latest sampled animation tick as soon as
preparation finishes. Compositions capture their children before preparing any child.

Monitor append progress is tracked per trace and field, including disjoint frame ranges. Pending
ranges pass to a bounded job only after cancellable domain preparation succeeds, and the job
consumes queued geometry only on submission. Camera-independent tiles reuse derived geometry and
exact extrema across domain changes; partial summary buckets are refined against application data.
The cache is bounded by the monitor's history budget and falls back to local data queries when
coverage, resolution, or capacity is insufficient. This does not add retention or replay to models
or transport: applications continue to own observation history.

Renderer authors implement the lifecycle through `kit.Renderer`:

```ts
const renderer: kit.Renderer = {
  capture() {
    const snapshot = desired;
    return {
      async prepare(frame) {
        const candidate = await prepare(snapshot, frame);
        return {
          encode: (encoding) => candidate.encode(encoding),
          submitted: () => commit(candidate),
          discard: () => candidate.discard(),
        };
      },
      release() {
        /* release snapshot resources after preparation settles */
      },
    };
  },
  destroy() {
    /* release renderer resources */
  },
};
```

`kit.BaseView` handles capture and request coalescing for built-in views. Custom renderers must keep
captured inputs stable until `release`; `submitted` and `discard` settle a prepared candidate once.
