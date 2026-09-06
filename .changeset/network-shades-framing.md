---
'@latkit/network': minor
---

A fragment shade hook, a framed fit, an inspect interaction mode, an external pointer, and a first-paint signal. Every one costs the same on any graph: a shade is one 64-float upload per frame, a framed fit is the refit the controller already does on resize, and the pointer is the hover probe the canvas already keeps.

- Added: `setShade(shade)` installs WGSL `fn shade(f: Fragment) -> vec4f` into the vertex and edge passes with an optional per-frame `tick` over a `host` block; `@latkit/network/shades` ships `spotlight`; the raw `vertexShade` and `edgeShade` channels carry one scalar per item into a shade as `f.value`; `u.pointer_px` is the latest pointer in canvas-local CSS pixels.
- Added: the `fitPaddingPx`, `fitPitch`, and `fitBearing` options define the fit every resize, `fit()`, Home key, and double-tap returns to, so a framed view stays framed without host code.
- Added: the `interaction` option. `'inspect'` keeps hover, tap selection, and arrow-key stepping along the topology while wheel and touch scrolling stay the page's; `'none'` installs no listeners.
- Added: `setPointer(clientX, clientY)` and `setPointer(null)` report a pointer from outside the canvas through the same hover path; `painted` as an event and a property reports the first frame after each attach; `pause()` clears hover at once.
- Changed: the uniform block grows to 448 bytes and the channels bind group carries the shade's host block at binding 4; a shader build failure names every compilation error it can find.
