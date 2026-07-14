# Architecture

Latkit is organized as a small monorepo. Each published package owns a single public entrypoint and emits bundled ESM plus TypeScript declarations.

## Runtime shape

Applications create, size, and own their canvases. Rendering packages borrow a canvas and native Core `GPUDevice`, configure the WebGPU presentation context, attach interaction and resize handling, and own only renderer-specific resources. Applications call `destroy()` before releasing either borrowed object.

Both renderers use WebGPU resources internally. Public APIs stay imperative on purpose: data often arrives from simulation, telemetry, or graph pipelines where direct controller methods are easier to integrate than a framework-specific component model.

## Package boundaries

`@latkit/model`
: Keeps shared model primitives small and dependency-light as the package family grows.

`@latkit/colormaps`
: Owns color catalogs and formatting helpers. Rendering packages can consume this package without duplicating palette data.

`@latkit/gpu`
: Centralizes Core WebGPU device requests and typed availability failures. It returns a native Core `GPUDevice`; applications own its lifetime and their canvases, while rendering packages own canvas configuration and renderer resources.

`@latkit/monitor`
: Owns monitor-specific state, WebGPU resources, and rendering behavior.

`@latkit/network`
: Owns topology codecs, camera models, picking, input handling, and WebGPU rendering for network views.

## Documentation boundary

Human-authored docs live under `docs/`. Generated API reference is written to `docs/api/reference/` by TypeDoc and is intentionally ignored by git.

The generated API docs are built from package entrypoints instead of source directories. That keeps the published API obvious and prevents internal implementation modules from becoming accidental documentation commitments.

## Public API boundary

Consumers should import from package roots such as `@latkit/network` and `@latkit/monitor`. Source paths under `packages/*/src` are implementation details.

Generated reference pages document only exported package entrypoints. If a symbol appears in the reference, treat it as part of the public contract unless it is marked internal and excluded from the generated docs.
