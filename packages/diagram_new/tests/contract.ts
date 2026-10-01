import { createDiagram, arrange, attachDiagramInput } from '../src/index.js';
import type { Gpu, Renderer, ColorScale, FieldValues } from '@latkit/gpu';
import type { Document } from '@latkit/model';
export async function usage(
  gpu: Gpu,
  document: Document,
  canvas: HTMLCanvasElement,
  color: ColorScale,
): Promise<Renderer> {
  const data = {
    source: document,
    components: { node: { color, labels: { field: 'name' } } },
    connections: { link: { route: 'orthogonal' as const } },
  };
  const positions = await arrange({
    data,
    measureText: (input, options) => gpu.measureText(input, options),
  });
  const diagram = createDiagram({
    gpu,
    data: { ...data, components: { node: { ...data.components.node, position: positions.node } } },
  });
  attachDiagramInput({ diagram, canvas, interaction: 'edit' });
  diagram.on('delete', (ids) => {
    void document.edit?.([{ kind: 'remove', ids }]);
  });
  diagram.on('move', ({ positions }) => {
    const fields: Readonly<Record<string, FieldValues>> = positions;
    void fields;
  });
  // @ts-expect-error The diagram never owns document mutation.
  void diagram.edit;
  return diagram;
}
