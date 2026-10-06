import { createDiagram, arrange, type Diagram } from '../src/index.js';
import type { Gpu, ColorScale, Positions } from '@latkit/gpu';
import { itemId, type Data } from '@latkit/model';
export async function usage(
  gpu: Gpu,
  model: Data,
  remove: (ids: readonly string[]) => Promise<void>,
  canvas: HTMLCanvasElement,
  color: ColorScale,
): Promise<Diagram> {
  const config = {
    source: model,
    vertices: { vertex: { color, labels: 'name' } },
    edges: { link: { route: 'orthogonal' as const } },
  };
  const positions = await arrange(gpu, config);
  const diagram = createDiagram(gpu, {
    ...config,
    canvas,
    input: 'edit',
    vertices: { vertex: { ...config.vertices.vertex, ...positions.vertex } },
  });
  // Rows name what to delete; their ids are how an application writes the change back.
  diagram.on('delete', (rows) => {
    void remove(rows.map(itemId));
  });
  diagram.on('move', ({ positions }) => {
    const fields: Readonly<Record<string, Positions>> = positions;
    void fields;
  });
  diagram.set({ layout: { direction: 'down' }, camera: { scale: 2 } }, { animate: true });
  // @ts-expect-error The diagram never owns document mutation.
  void diagram.edit;
  return diagram;
}
