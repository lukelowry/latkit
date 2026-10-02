import { createDiagram, arrange, type Diagram } from '../src/index.js';
import type { Gpu, kit } from '@latkit/gpu';
import type { Data } from '@latkit/model';
export async function usage(
  gpu: Gpu,
  model: Data,
  remove: (ids: readonly string[]) => Promise<void>,
  canvas: HTMLCanvasElement,
  color: kit.ColorScale,
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
    layout: 'manual',
    vertices: { vertex: { ...config.vertices.vertex, position: positions.vertex } },
  });
  diagram.on('delete', (ids) => {
    void remove(ids);
  });
  diagram.on('move', ({ positions }) => {
    const fields: Readonly<Record<string, kit.FieldValues>> = positions;
    void fields;
  });
  diagram.set({ layout: { direction: 'down' }, camera: { scale: 2 } }, { animate: true });
  // @ts-expect-error The diagram never owns document mutation.
  void diagram.edit;
  return diagram;
}
