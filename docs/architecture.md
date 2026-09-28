# Architecture

Latkit is organized as a small monorepo. Each published package owns a single public entrypoint and emits bundled ESM plus TypeScript declarations.

## Runtime shape

Applications create, size, and own their canvases. A controller is created without a device or a canvas and holds everything a host gives it; `attach(canvas)` leases a device from a shared pool and paints that state, `detach()` returns both and keeps it, and a lost device is replaced inside the controller. See [Lifecycle and failures](lifecycle.md).

Public APIs stay imperative on purpose: data often arrives from simulation, telemetry, or graph pipelines where direct controller methods are easier to integrate than a framework-specific component model. `@latkit/embed` is the declarative form of the same controllers for pages that want a tag.

## Package boundaries

`@latkit/model`
: Owns the classes a format, an engine, and an editor implement, and what they make. A format subclasses `Model` to read its cases, and the model is the instance every question about a case goes to: `elementAt`, `itemOf`, `load`, `field`, `fields`, `grid`, `record`, and `source` are its methods. An engine subclasses `Engine`; attached to a model at any time, it fills the `Recording` `record` returns, which keeps every recorded class on one clock and says whether it waits, records, or ended. A format that edits subclasses `Document`: operations in the model's identities, one history, and the case as a schematic the diagram draws. A `Series` is what every view follows, and a field is the `{ series, signal }` every renderer binds, a column being a sealed series of one frame. Everything lazy opens from a source: `Model.from` opens a model's packs, `Recording.from` a recording held elsewhere, from a file or across a port. The structures renderers load and pick live under the classes that make them, `Model.Topology` and `Model.Item`, `Document.Netlist` and `Document.Part`, with `Domain` and the checks a host runs before a device exists. Depends on nothing.

`@latkit/colormaps`
: Owns the color vocabulary: the `RGBA` every color option takes and its check, the `Colormap` every colormap option takes, the `COLORMAPS` catalog with its transfer functions and CSS gradients, and `parseColor`. Depends on nothing.

`@latkit/gpu`
: Owns what every renderer shares. Devices: `requestDevice`, typed availability failures, and the pool, where `devices` is the realm-wide pool every renderer leases from unless given another and `createDevicePool` makes a private one. Canvases: `createPresentation`, and `createFrameLoop`, which schedules one canvas's frames, re-renders before the next paint when the canvas resizes, and grows the backing store in steps of 64 device pixels while a resize is in flight. Controllers: `createAttachment`, the attach lifecycle with supersession, joining a repeat attach, and recovery from device loss, and `createEmitter` for their events. Data: `createChannels`, the channel binder every renderer's `setChannel` runs on, with a slot per channel in one store, domains, and series followed around a playhead with their frames resident on the GPU; and `bakeColormap`, the lookup texture every shader samples. It returns native platform objects and takes ownership only of a pooled device, for exactly as long as a lease holds it. Depends on `@latkit/model` and `@latkit/colormaps` for types.

`@latkit/monitor`
: Owns monitor-specific state, WebGPU resources, and rendering behavior behind one `Monitor` controller and its `OPTIONS` registry.

`@latkit/network`
: Owns topology codecs, camera models, picking, input handling, and WebGPU rendering for network views behind one `Network` controller, which also carries the view and input policy every host would otherwise repeat. Three registries, `CHANNELS`, `OPTIONS`, and `PROJECTIONS`, name what it speaks; `loadBorders` loads the packaged border geometry, and `spotlight` is a finished shade. Its channels are a registry and a record writer over `@latkit/gpu`'s binder.

`@latkit/diagram`
: Owns netlist preparation, automatic layout, wire routing, glyph text, picking, editing gestures, and WebGPU rendering for block diagrams behind one `Diagram` controller and its `CHANNELS` and `OPTIONS` registries. It never edits a netlist: what the user draws, moves, or deletes is a proposal event, and the host loads the result. `arrange` is the same layout without a device or a DOM, and the entrypoint loads in a worker. Its GPU channels run on `@latkit/gpu`'s binder; `blockPosition` is the scene's own placement.

`@latkit/embed`
: Owns the declarative form: `latkit-network` and `latkit-monitor`, each a shadow canvas that fills the host, a data source, an attribute for every option, and the controller itself at `element.network` or `element.monitor`. No chrome. `register()` defines both tags; `embed.js` is the same, as a page script. Depends on the two renderers, `@latkit/model`, and `@latkit/colormaps`.

`@latkit/port`
: Owns every boundary crossing: the `Port` over workers, webviews, sockets, and one thread; the binary frame that carries typed arrays intact; protocols served and connected over a port, with the `check`s a served side runs; and a model and its recordings served and connected: `serveModel` and `connectModel`, `serveRecording` and `connectRecording`. What crosses is a model's source, never a shadow of the model: the far side opens it with `Model.from` and `Recording.from`, and a far model's engine forwards each recording to the served engine, which checks its input. Formats stay outside it: an engine turns its files into recorder calls, and the port carries only those. Depends on `@latkit/model`.

## Documentation boundary

Human-authored docs live under `docs/`. Generated API reference is written to `docs/api/reference/` by TypeDoc and is intentionally ignored by git.

The generated API docs are built from package entrypoints instead of source directories. That keeps the published API obvious and prevents internal implementation modules from becoming accidental documentation commitments.

## Public API boundary

Consumers import from package roots such as `@latkit/network`, `@latkit/monitor`, and `@latkit/diagram`; a package root is the only entrypoint there is. Source paths under `packages/*/src` are implementation details.

Generated reference pages document only exported package entrypoints. If a symbol appears in the reference, treat it as part of the public contract unless it is marked internal and excluded from the generated docs.

Every barrel follows the same rules, so the surfaces stay small and alike:

- The instance is the API. Anything that would take a controller as its first argument is a method on that controller.
- One registry per vocabulary. `CHANNELS`, `OPTIONS`, `PROJECTIONS`, and `COLORMAPS` each carry every label, default, and kind; there are no parallel constants or lookup helpers.
- A type is exported only when a caller must name it in a signature, and it lives under the class that speaks it, `Document.Operation` or `Engine.Recorder`, through a type-only namespace. Sub-shapes are reached by indexed access.
- Validation lives at the boundary that throws. The standalone validators are the ones a host needs before a device exists: each renderer's `validateOptions`, `validateTopology`, `validateNetlist`, `validateSeries`, and `validateDomain` in `@latkit/model`, and `validateRgba` in `@latkit/colormaps`. A port's `check`s throw the same way, naming what is wrong.
- A controller outlives its canvas and its device. Everything a host gives it is retained across `detach` and `attach`, and a lost device is recovered inside the controller.
- One home per type. `Model.Topology`, `Model.Item`, `Document.Netlist`, `Document.Part`, `Series`, `Recording`, `Model.Field`, and `Domain` are defined in `@latkit/model`, and `RGBA` and `Colormap` in `@latkit/colormaps`, and imported from there; no renderer re-exports them.
- One binding currency. Every renderer that follows a history takes `{ series, signal }`, the shape a model's field is, so a host binds a field without adapting it.
- Extension is subclassing. A format, an engine, an editor, and a source of samples each extend the class whose contract it fulfils, `Model`, `Engine`, `Document`, or `Series`, and implement its protected hooks; the base keeps the behavior every subclass shares.
- One entry point. A package's `index.ts` is its only entrypoint: no subpath, whether to hide plumbing or to trim a bundle. Code shared by renderers lives in the package whose job it is, `@latkit/gpu`, and a split for weight is a dynamic import inside the package. Assets and the embed page script are files, not entrypoints.
- Code lives with the vocabulary it serves. A thing that crosses a boundary crosses as its source, and its far side is built by the package that owns it, never shadowed by the one that carries it.

Names follow one convention across every package and every layer, from option to uniform to shader:

- The API spells out `vertex` and `edge`, kind first: `vertexScale`, `edgeBaseColor`. The uniform buffer and its shaders abbreviate a per-item word to `v`/`e` (`vHoverPx`, `v_hover_px`, `W_V_HOVER_PX`), so an option maps onto its word mechanically. A diagram spells out `block`, `port`, `net`, and `group` the same way (`blockColor`, `netBaseColor`) and calls one pickable item of any kind a part.
- A raw value maps to a normalized `t` as `(x - min) * scale`; an output range is `outMin + t * outSpan`. `Scale` on an option means a user multiplier and nothing else.
- Units travel with the name: `Px` (`_px`) is CSS pixels, `Ms` a duration, `Time` an epoch instant. A device-pixel value says so, as `viewport`, `backingScale`, or a `DevPx` suffix, or its shader states once at the top that it works in device pixels. A diagram's own unit, a CSS pixel at zoom 1 that scales with the view, carries no suffix: `gridPitch` (`grid_pitch`) is in diagram units, while the shade's `pointer_px` is in CSS pixels.
- A bitmask is `<x>.flags` (`<x>_flags`) and its bits are `<X>_*`: `display.flags` with `DISPLAY_*`, `focus.flags` with `FOCUS_*`.
- One word per visual: the extra disc or band around a focused item is a halo; the coordinate grid is the graticule.
