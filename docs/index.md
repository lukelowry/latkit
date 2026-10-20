# latkit

Columnar data drawn as vertices, edges, lines, and areas on the GPU: networks of millions of rows,
maps, live time series, and block diagrams, in the browser with the npm package, or as pictures and
video with the command line.

```sh
npm install latkit
```

```ts
import { loadLatkit, Patch, field, type Scene } from 'latkit';

const { Data, Gpu } = await loadLatkit();
const data = new Data('grid').apply(
  new Patch().replace('Bus', [101, 102], { x: [0, 30], y: [0, 20], kv: [230, 115] }),
);

const scene: Scene = {
  space: 'plane',
  marks: [
    {
      vertices: {
        of: ['grid', 'Bus'],
        position: ['x', 'y'],
        radius: 6,
        color: field('kv').colormap('viridis'),
      },
    },
  ],
};

const gpu = await Gpu.create();
const view = gpu.view(scene);
gpu.canvas(document.querySelector('canvas')!).show([view]);
view.setData(data);
view.fit();
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
```
