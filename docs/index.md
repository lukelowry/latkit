# latkit

Columnar data drawn as vertices, edges, lines, and areas on the GPU: networks of millions of rows,
maps, live time series, and block diagrams, in the browser with the npm package, or as pictures and
video with the command line.

```sh
npm install latkit
```

Call `quickstart(canvas)` with your canvas element. Destroy the returned `gpu` and `data` when
unmounting the application. This example is type-checked and rendered in the package consumer test.

```{literalinclude} ../npm/test/consumer/quickstart.ts
:language: typescript
```

A **dataset** is named tables of columns, changed by **patches**. A **scene** says what to draw:
marks naming tables, in a space, with a theme and controls. A **view** draws a scene from the
datasets it is given, on a canvas or into pictures. Scenes, expressions, and patches are plain data
that need no WebAssembly; `loadLatkit()` loads it for data and drawing.

```{toctree}
:maxdepth: 1

data
scenes
views
pictures
cli
formats
deployment
rust
reference/api
reference/types
reference/cli
releasing
```
