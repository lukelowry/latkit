# Performance

Each row is a benchmark scenario at the largest size it ran, in Chrome on one GPU. **Open** is the
time from creating the view until it has drawn everything. **Frame** and **GPU** are the median CPU
and GPU milliseconds per frame while the view moved, in its slowest moving phase. **Pick** is the
time to answer a pick or hover. `cargo xtask bench` runs every scenario at increasing sizes and
checks it against the committed baselines; `node benchmark/docs.ts` writes this table from them.

```{csv-table}
:file: _static/performance.csv
:header-rows: 1
:class: numbers
```

## What a page is held to

The browser gate first compiles every pipeline cold in Chrome; each must compile within 800 ms.
It then opens each example page in a fresh Chrome without a shader cache, moves the pointer over it
(hovering, zooming, panning, clicking, and stepping through rows with the keys), and exports a
picture.

A page fails at once on:

- a console or page error;
- a pipeline compiled where it is first used, which holds back the frames that use it;
- no picture exported.

A page is late if any view has drawn no frame 1,000 ms after the page opens, or if the page misses
more than one display frame in a row while opening or under the pointer. A late page is opened again,
cold, and fails only if it is late both times: a stall of the machine slows one open, while a slow
page slows both.

On SwiftShader, which draws on the CPU, the gate only checks that every pipeline compiles; page
timings need a GPU.

## What makes it fast

- Every row's drawing is computed on the GPU, so a frame's CPU time stays the same however many rows
  draw; only the GPU's work grows.
- Pipelines compile in the background, off the GPU's thread, before any frame needs them: first those
  the next frame draws with, then text, then the rest, a few at a time.
- Each pipeline contains only the code its mark uses: the primitive it draws, and whether it reads
  joins, sampled fields, or view state.
- A table too large to draw whole is paged: the view draws only the pages the camera needs, within
  the GPU memory budget. A page keeps its GPU slot while the camera moves, and stays resident after
  the camera leaves while the budget allows, so returning to it needs no upload.
- Data derived for drawing, such as edge lanes, triangles, and fitted domains, is recomputed when the
  data changes, never when the camera moves. A page's triangles are built the first time it draws.
- Map tiles are decoded and shaped in workers, so a tile arriving costs the frame only a copy of its
  rows.
- A write updates only the pages holding the rows it changed, and an append only the page the new
  rows go into. A paged table's spatial tiles are rebuilt only once the rows appended since the last
  build reach an eighth of the rows it was built from.
