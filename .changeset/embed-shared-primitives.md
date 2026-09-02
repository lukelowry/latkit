---
'@latkit/embed': minor
---

Build `latkit-network` on the tightened primitives of its dependencies and mirror the new `Network` surface one-to-one.

- The device pool, colormap registry, and Network registries now come from `@latkit/gpu` (`createDevicePool`), `@latkit/colormaps` (`COLORMAPS`, `gradient`), and `@latkit/network` (`CHANNELS`, `OPTIONS`, `PROJECTIONS`, `validateOptions`) instead of private copies or removed helpers. The attribute table is derived from `OPTIONS` and `CHANNELS`.
- `hover` and `select` DOM events carry an `Item | null` detail (`{ kind, index }`), `zoom` and the new `orbit` event carry a boolean, `deviceLost` carries `{ reason, message, recovering }`, and `pipelineError` carries `{ family, cause }`. The separate `*EventDetail` interfaces are gone; `NetworkElementEventMap` inlines every detail shape.
- The element forwards exactly the `Network` verbs: `setOptions`, `setBorders`, `setChannel(channel, values | null, domain?)`, `setChannelDomain`, `getChannelDomain`, `setProjection(mode, fallback?)`, `fit`, `reveal`, `neighborhood`, `select(item | null)`, `panBy`, `rotateBy`, `getPose`, `setPose(pose, animate?)`, `zoomBy`, `orbit`, `pause`, and `resume`, plus the readonly `projections`, `geographic`, and `orbiting`.
- The height output range is the ordinary live option `heightRange`, reflected as the `height-range` attribute; the per-channel `vertex-height-range` attribute and the fourth `setChannel` argument are gone.
- Removed: `setColormap` (use `setOptions({ colormap })`), `setBaseColor` (use `setOptions({ baseColor })`), `clearChannel` (use `setChannel(channel, null)`), `setChannelRange` (use `setChannelDomain`), `clearSelection` (use `select(null)`), and `fadeIn`. The barrel exports only `register`, `parseNetwork`, and the types `NetworkElement`, `NetworkElementEventMap`, `NetworkData`, and `NetworkJSON`.

The border binaries remain published under `@latkit/embed/assets/*` for the standalone bundle.
