import { describe } from 'vitest';
import { createDiagram, type DiagramConfig } from '@latkit/diagram';
import { counters, draw, gpu, grid, suite } from './harness.ts';

interface DragControls {
  preview(items: readonly unknown[], delta: readonly [number, number] | null): void;
}

/** Include the large routed scene, with fewer repetitions at forty thousand blocks. */
describe.each([100, 1_000, 10_000, 40_000])('diagram %i blocks', async (blocks) => {
  const device = await gpu(),
    data = grid(blocks, true);
  const config: DiagramConfig = {
    source: data,
    vertices: { Bus: {} },
    edges: { Branch: { ends: ['from', 'to'] } },
    // Large stress scenes explicitly opt into a larger picking budget.
    ...(blocks >= 40_000 ? { limits: { pickingBytes: 128 * 1024 ** 2 } } : {}),
  };
  const view = createDiagram(device, config);
  await draw(device, view, 0, 'complete');
  const measure = suite(
    `diagram ${blocks} blocks`,
    blocks,
    () => counters(device),
    blocks >= 40_000 ? 3 : 8,
  );
  measure('layout', async () => {
    const fresh = createDiagram(device, config);
    await draw(device, fresh, 0, 'complete');
    fresh.destroy();
  });
  measure('cached frame', () => draw(device, view));
  // Nothing is sampled, so playback must not read the scene again.
  measure('playback frame', (i) => draw(device, view, i));
  measure('pick', () => view.pick([640, 360]));
  // A drag previews one vertex moving; its gestures drive the view's controls.
  const controls = (view as unknown as { readonly controls: DragControls }).controls,
    dragged = await view.pick([640, 360], { radiusPx: 4000, limit: 1 });
  measure('drag frame', (i) => {
    controls.preview(dragged, [8 * (1 + (i % 4)), 0]);
    return draw(device, view);
  });
  measure('drag end', () => {
    controls.preview([], null);
    return draw(device, view);
  });
  measure('restyle', (i) => {
    view.set({ edgeWidthPx: 1 + (i % 2) });
    return draw(device, view);
  });
  // A sampled color restyles on the GPU at each coordinate and never rereads the scene.
  const styled = createDiagram(device, { ...config, vertices: { Bus: { color: 'voltage' } } });
  await draw(device, styled, 0, 'complete');
  measure('styled playback', (i) => draw(device, styled, i));
});
