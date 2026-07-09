# Architecture

Latkit is organized as a small monorepo. Each published package owns a single public entrypoint and emits bundled ESM plus TypeScript declarations.

## Package boundaries

`@latkit/model`
: Keeps shared primitives small and dependency-light.

`@latkit/colormaps`
: Owns color catalogs and formatting helpers. Rendering packages can consume this package without duplicating palette data.

`@latkit/monitor`
: Owns monitor-specific state, WebGPU resources, and rendering behavior.

`@latkit/network`
: Owns topology codecs, camera models, picking, input handling, and WebGPU rendering for network views.

## Documentation boundary

Human-authored docs live under `docs/`. Generated API reference is written to `docs/api/reference/` by TypeDoc and is intentionally ignored by git.

The generated API docs are built from package entrypoints instead of source directories. That keeps the published API obvious and prevents internal implementation modules from becoming accidental documentation commitments.
