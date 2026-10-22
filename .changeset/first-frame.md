---
'latkit': patch
---

A view's first frame waits only for what draws its marks, a browser's first GPU is made while the runtime loads, pipelines compile only what their marks are and read, and the wasm is an eighth smaller. Diagrams look as modern as the rest: bordered blocks and groups that cast soft shadows, with corners, ports, and bends the theme sets.

- Added: the theme's `outline`, `corner`, `portSize`, and `bend` set a diagram's block and group borders, their corners, its ports' width, and the radius of its wires' bends, which no longer follow `edgeSpacing`.
- Added: `shadow: true` on a diagram's blocks and groups lays a soft shadow on the sheet, `shadow.lift` units below them, in the theme's shadow color.
- Changed: a diagram's blocks and groups are bordered in the theme's `outline`, and a group draws no band behind its title. Corners, status rings, and ports' rings are part of the drawing and zoom with it; a status ring follows its marker's corners. A `block` marker's `corner` takes the theme's unless set.
- Changed: a block makes room for the labels of its top and bottom ports, which did not show.
- Changed: text is set in the system's sans-serif face unless the theme names one, where it was monospace.
- Changed: a diagram grid's dots are a CSS pixel across on every screen.
- Fixed: a mark ordered by `priority` draws the whole trace of the sampled field it traces; it drew nothing, and its plot fitted no values.
- Fixed: a plot's y-axis label hangs from the top of the room above the plot, so a taller face no longer pushes it off the picture.
- Fixed: a scene with two marks of one kind drawing one table asks for a `name`, as the option is called.
- Changed: pipelines compile through one queue per GPU, the most urgent first: what frames draw with at once, their text as the browser's compile workers free up, then what transitions, lit rows, probes, and queries need, a few at a time. A view asks for its scene's as it is shown rather than at its first frame.
- Changed: in a browser the GPU readies what nearly every scene draws with as its first view opens, once that view's frames have all they draw with; a GPU no view uses compiles nothing.
- Changed: `loadLatkit()` asks for a GPU adapter as the runtime starts loading, so the browser's GPU process starts meanwhile, and makes the page's first GPU as it loads; the first `Gpu.create()` takes it.
- Changed: a view's first frame draws its marks; labels, glyphs, and the overlay join once their pipelines landed, fading in as after any change. `complete` still waits for all of it.
- Changed: a mark's channels compile for what they read: without fields of other tables, sampled fields, or `selected()`, `hovered()`, `pointer()`, and `zoom()`, their pipeline leaves each out. Fitted domains reduce in the channels' own pipeline.
- Changed: label placement and the label draw compile for their mark's primitive, points, strokes, or triangles, as probes do: a quarter of the time for labels on points. Probes see each instance through one call, and placement passes no longer compile once per path.
- Fixed: a plot's axes start below its title and subtitle, which drew over the plot.
- Changed: the globe's atmosphere is a thin rim and a halo about as thick as the earth's air, where it was a wide glow over the ground and the marks near the globe's edge.
- Changed: every transition eases through the settled state, so evaluating channels knows nothing of transitions.
- Changed: expressions, sizes, labels, and colormaps are read where they are written, so error paths reach into expressions.
- Changed: the wasm is 12% smaller (11% gzipped): sorts, name-keyed tables, and JSON reading each compile once, and URLs resolve without the `url` crate.
