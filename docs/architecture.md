# Architecture

Latkit is organized as a small monorepo. Each published package owns a single public entrypoint and emits bundled ESM plus TypeScript declarations.

## Runtime shape

Applications create, size, and own their canvases. Rendering packages borrow a canvas and native Core `GPUDevice`, own a shared `@latkit/gpu` presentation, attach interaction and resize handling, and own renderer-specific resources. Applications call `destroy()` before releasing either borrowed object.

Both renderers use WebGPU resources internally. Public APIs stay imperative on purpose: data often arrives from simulation, telemetry, or graph pipelines where direct controller methods are easier to integrate than a framework-specific component model.

## Package boundaries

`@latkit/model`
: Owns the immutable, columnar network model, its packed series, and its byte form, and with them the vocabulary the renderers speak: `Topology`, `Item`, and `Series` are defined here once. Depends on nothing.

`@latkit/colormaps`
: Owns color catalogs and formatting helpers. Rendering packages can consume this package without duplicating palette data.

`@latkit/gpu`
: Centralizes Core WebGPU device requests, typed availability failures, canvas presentation mechanics, and one device shared by many renderers through `createDevicePool`. It returns native platform objects and takes ownership only of a pooled device, for exactly as long as a lease holds it.

`@latkit/monitor`
: Owns monitor-specific state, WebGPU resources, and rendering behavior.

`@latkit/network`
: Owns topology codecs, camera models, picking, input handling, and WebGPU rendering for network views behind one `Network` controller, which also carries the view policy every host repeats: neighborhood reveal, projection fallback, and continuous rotation. Three registries, `CHANNELS`, `OPTIONS`, and `PROJECTIONS`, name what it speaks, and `@latkit/network/borders` loads the packaged border geometry. Depends on `@latkit/model` for its vocabulary and on `@latkit/gpu` for presentation.

`@latkit/port`
: Owns the boundary between two halves of one application: the `Port` over workers, webviews, and sockets, the binary frame that carries typed arrays intact, and the protocols served and connected over a port. Depends on nothing and knows nothing about models.

`@latkit/remote`
: Owns a model as it crosses a port: `serveSource` and `connectSource` for a source and its runner, `serveGrid` and `connectGrid` for a grid, `serveResults` and `connectResults` for what a run recorded. Depends on `@latkit/model` and `@latkit/port`; it is the only package that knows both. Formats stay outside it: a vendor turns its files into `RunFrames`, and the port carries only those.

## Documentation boundary

Human-authored docs live under `docs/`. Generated API reference is written to `docs/api/reference/` by TypeDoc and is intentionally ignored by git.

The generated API docs are built from package entrypoints instead of source directories. That keeps the published API obvious and prevents internal implementation modules from becoming accidental documentation commitments.

## Public API boundary

Consumers should import from package roots such as `@latkit/network` and `@latkit/monitor`. Source paths under `packages/*/src` are implementation details.

Generated reference pages document only exported package entrypoints. If a symbol appears in the reference, treat it as part of the public contract unless it is marked internal and excluded from the generated docs.

Every barrel follows the same rules, so the surfaces stay small and alike:

- The instance is the API. Anything that would take a controller as its first argument is a method on that controller.
- One registry per vocabulary. `CHANNELS`, `OPTIONS`, `PROJECTIONS`, and `COLORMAPS` each carry every label, default, and kind; there are no parallel constants or lookup helpers.
- A type is exported only when a caller must name it in a signature. Sub-shapes are reached by indexed access.
- Validation lives at the boundary that throws. The standalone validators are the two a host needs before a device exists, `validateOptions` and `validateTopology`.
- `@latkit/model` owns the shared vocabulary: `Topology`, `Item`, and `Series` are defined there once and re-exported by the renderers.
