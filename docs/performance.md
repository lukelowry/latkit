# Performance

Each row is a benchmark scenario at the largest size it ran, in Chrome on one GPU. **Open** is the
time from creating the view until it has drawn everything. **Frame** and **GPU** are the median CPU
and GPU milliseconds per frame in the scenario's slowest phase with a moving view. GPU time counts
the GPU's work on the frame's commands, not its waits between them. **Pick** is the
time to answer a pick or hover. `cargo xtask bench` runs every scenario at increasing sizes and
checks it against the committed baselines. `node benchmark/docs.ts` writes this table from those
baselines, measured with WebGL2 through ANGLE on Direct3D 11.

```{csv-table}
:file: _static/performance.csv
:header-rows: 1
:class: numbers
```

## What a page is held to

The browser gate first compiles every pipeline cold in Chrome. Each must compile within 800 ms. It
then opens each example page in a fresh Chrome with no shader cache, moves the pointer over it
(hovering, zooming, panning, clicking, and stepping through rows with the keys), and exports a
picture.

A page fails at once on:

- A console or page error.
- A pipeline compiled when it is first used, which holds back the frames that use it.
- No exported picture.

A page is late if any view has not drawn a frame 1,000 ms after the page opens, or if the page
misses more than one display frame in a row while opening or under the pointer. A late page is
opened again, cold, and fails only if it is late both times. A machine stall slows one open, but a
slow page slows both.

On SwiftShader, which draws on the CPU, the gate only checks that every pipeline compiles. Page
timings need a GPU.

## What makes it fast

- The GPU computes how every row draws, so a frame's CPU time does not grow with the number of
  rows. Only the GPU's work grows.
- Pipelines are requested before use, with drawing first, then text, then input and other work.
  The passes that measure rows for a fit come first only while a fit waits for them. A new scene
  draws once its pipelines have compiled, after those of the scene drawn, so the view never stops
  drawing while they compile. A mark drawing its opaque pixels first, where depth varies, uses the
  same program as its other pixels. The browser
  shares compiled stages and programs, and polls readiness through
  [KHR_parallel_shader_compile](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/)
  when available. Without that extension, checking a program's link result can still block.
- Each pipeline contains only the code its mark uses: the primitive it draws, and whether it reads
  joins, sampled fields, or view state. Shaders read every value they might need and then select
  one, since Direct3D's compiler takes far longer over branches around reads.
- latkit's shaders are translated to GLSL when latkit is built. A custom marker or shade is
  translated alone, once, and completes each of latkit's shaders that call it.
- A table too large to draw at once is split into pages. The view draws only the pages on screen,
  within the GPU memory budget. A page stays on the GPU while the camera moves, and after the
  camera leaves while the budget allows, so coming back to it needs no upload.
- Data derived for drawing, such as edge lanes, triangles, and fitted domains, is recomputed when
  the data changes, never when the camera moves. A page's triangles are built the first time it
  draws.
- Map tiles are decoded and shaped in workers. An arriving tile appends its rows to its tables,
  which are paged like any large table, so only the pages those rows fill upload and evaluate.
  Tiles split by the area they cover on screen, so the globe's edge and a tilted horizon stay
  coarse. When the tile budget runs out, the tiles drawn largest split first.
- A write updates only the pages that hold the rows it changed, and an append updates only the page
  the new rows go into. A paged table rebuilds its spatial tiles only once the rows appended since
  the last build reach an eighth of the rows that build used.
