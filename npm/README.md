# latkit

Large networks, such as power grids, drawn with WebGPU: datasets of tables, scenes of vertices,
edges, lines, and areas over them, and pictures and video of the views.

```ts
import { Data, Gpu, Patch, field, load, type Scene } from 'latkit';

await load();
const grid = new Data('grid').apply(
  new Patch().replace('Bus', [101, 102], { x: [0, 30], y: [0, 20], kv: [230, 115] }),
);

const scene: Scene = {
  space: 'plane',
  marks: [
    {
      vertices: {
        of: ['grid', 'Bus'],
        position: ['$x', '$y'],
        radius: 6,
        color: field('kv').colormap('viridis'),
      },
    },
  ],
};
const gpu = await Gpu.create();
const view = gpu.view(scene, { sources: [grid] });
gpu.canvas(document.querySelector('canvas')!, { layout: [{ view }] });
view.fit();

grid.apply(new Patch().set('Bus', [102], { kv: [345] })); // drawn the next frame
```

Scenes, expressions, and patches are plain data, typed from latkit's schema, and need no
WebAssembly, so a worker or a server builds them too. The
[guide](https://latkit.readthedocs.io/en/latest/guide.html) shows each task, and the
[API reference](https://latkit.readthedocs.io/en/latest/reference/api.html) documents every export.
