import { View, load } from 'latkit';
import { threeBusGrid, voltageDiagram } from './three-bus';

export async function quickstart(canvas: HTMLCanvasElement) {
  await load();
  const grid = threeBusGrid();
  const view = await View.create(canvas, voltageDiagram(grid));
  return { view, grid };
}
