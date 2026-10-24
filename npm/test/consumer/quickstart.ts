import { Data, Gpu, Patch, field, type Scene } from 'latkit';

/** A complete, type-checked example, also rendered by the installed-package test. */
export async function quickstart(canvas: HTMLCanvasElement) {
  const gpu = await Gpu.create();
  const grid = new Data('grid').apply(
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
  const view = gpu.view(scene, { sources: [grid] });
  gpu.canvas(canvas, { layout: [{ view }] });
  view.fit();
  return { gpu, view, grid };
}
