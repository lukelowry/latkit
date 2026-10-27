import { Data, View, field, load } from 'latkit';

/** Draws two buses on `canvas`, colored by their voltage. */
export async function quickstart(canvas: HTMLCanvasElement) {
  await load();
  const grid = new Data('grid').set('Bus', [101, 102], { x: [0, 30], y: [0, 20], kv: [230, 115] });
  const view = await View.create(canvas, {
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
  return { view, grid };
}
