# latkit

Draw large networks, such as power grids, with WebGPU. Write datasets of tables, describe scenes of
vertices, edges, lines, and areas over them, and export pictures and video of the views.

```ts
import { Data, View, field, load } from 'latkit';

await load();
const grid = new Data('grid').set('Bus', [101, 102], { x: [0, 30], y: [0, 20], kv: [230, 115] });

const view = await View.create(document.querySelector('canvas')!, {
  space: 'plane',
  marks: [
    {
      vertices: grid.table('Bus'),
      position: ['$x', '$y'],
      radius: 6,
      color: field('kv').colormap('viridis'),
    },
  ],
});

grid.set('Bus', [102], { kv: [345] }); // drawn the next frame
```

A scene is plain data, with types from latkit's schema. Scenes, expressions, and patches need no
WebAssembly, so you can build them in a worker or on a server too. The
[guide](https://latkit.readthedocs.io/en/latest/guide.html) shows each task, and the
[API reference](https://latkit.readthedocs.io/en/latest/reference/api.html) documents every export.
