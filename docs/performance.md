# Performance

Each benchmark scenario at the largest size it ran, in Chrome on one GPU: what opening took, and the
most a frame took on the CPU and the GPU while the view moved, and to answer a pick or the hover. A
frame's CPU time stays the same however many rows draw; the work grows on the GPU. `cargo xtask
bench` measures every scenario up its sizes and holds it to the committed baselines, and
`node benchmark/docs.ts` writes this table from them.

```{csv-table}
:file: _static/performance.csv
:header-rows: 1
:class: numbers
```

## What a page is held to

The browser gate opens every example page cold and moves the pointer over it. It fails when:

- a pipeline takes over 800 ms to compile, or fails to;
- a page draws no frame within a second;
- a page misses two display frames in a row while it opens or under the pointer;
- a pipeline compiles where it is first used, holding back the frames that use it.

## What makes it fast

- Every row's drawing is computed on the GPU, so a frame's CPU work stays the same however many
  rows draw.
- Pipelines compile off the GPU's thread before any frame uses them: what frames draw with at once,
  their text as compile workers free up, and the rest a few at a time.
- A pipeline compiles only what its mark reads and is: the primitive it draws, its joins, sampled
  fields, and view state.
- A table too large to draw whole draws the tiles the camera asks for, within the GPU's budget, a
  page of its order at a time. A page keeps its place on the GPU while the camera moves, and stays
  there while the budget leaves room once the camera moves on, so coming back costs nothing.
- What the view derives from the data, as lanes, triangles, and fitted domains, follows the data,
  never the camera: a page's triangles are made the first time it draws.
- A write costs the pages holding the rows it changed, and appending the page the rows land in:
  tiles are made again only once the rows appended since are an eighth as many as they hold.
