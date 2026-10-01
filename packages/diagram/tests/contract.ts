import { createDiagram, arrange, attachDiagramInput } from '../src/index.js';
import type { Gpu, Renderer, ColorScale, FieldValues } from '@latkit/gpu';
import type { Model } from '@latkit/model';
export async function usage(
  gpu: Gpu,
  model: Model,
  remove: (ids: readonly string[]) => Promise<void>,
  canvas: HTMLCanvasElement,
  color: ColorScale,
): Promise<Renderer> {
  const data = {
    source: model,
    vertices: { vertex: { color, labels: { field: 'name' } } },
    edges: { link: { route: 'orthogonal' as const } },
  };
  const positions = await arrange({
    data,
    measureText: (input, options) => gpu.measureText(input, options),
  });
  const diagram = createDiagram({
    gpu,
    data: {
      ...data,
      vertices: { vertex: { ...data.vertices.vertex, position: positions.vertex } },
    },
  });
  attachDiagramInput({ diagram, canvas, interaction: 'edit' });
  diagram.on('delete', (ids) => {
    void remove(ids);
  });
  diagram.on('move', ({ positions }) => {
    const fields: Readonly<Record<string, FieldValues>> = positions;
    void fields;
  });
  // @ts-expect-error The diagram never owns document mutation.
  void diagram.edit;
  return diagram;
}
