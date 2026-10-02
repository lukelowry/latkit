import { describe } from 'vitest';
import { createDiagram, type DiagramConfig } from '@latkit/diagram';
import { draw, gpu, grid, suite } from './harness.ts';

/** Layered layout is the heavy part, so diagrams scale to ten thousand blocks. */
describe.each([100, 1_000, 10_000])('diagram %i blocks', async (blocks) => {
  const device = await gpu(),
    data = grid(blocks, true);
  const config: DiagramConfig = {
    source: data,
    vertices: { Bus: {} },
    edges: { Branch: { ends: ['from', 'to'] } },
  };
  const view = createDiagram(device, config);
  await draw(device, view, 0, 'complete');
  const measure = suite(`diagram ${blocks} blocks`, blocks, () => device.stats(), 8);
  measure('layout', async () => {
    const fresh = createDiagram(device, config);
    await draw(device, fresh, 0, 'complete');
    fresh.destroy();
  });
  measure('cached frame', () => draw(device, view));
  // Nothing is sampled, so playback must not read the scene again.
  measure('playback frame', (i) => draw(device, view, i));
  measure('pick', () => view.pick([640, 360]));
  measure('restyle', (i) => {
    view.set({ edgeWidthPx: 1 + (i % 2) });
    return draw(device, view);
  });
});
