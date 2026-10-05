import { describe } from 'vitest';
import { createNetwork, type NetworkConfig } from '@latkit/network';
import { counters, draw, gpu, grid, sizes, suite } from './harness.ts';

describe.each(sizes)('network %i buses', async (buses) => {
  const device = await gpu(),
    data = grid(buses);
  const config: NetworkConfig = {
    source: data,
    vertices: {
      Bus: {
        x: 'position',
        y: { field: 'position', component: 1 },
        color: { field: 'voltage', domain: [0.95, 1.05] },
        radiusPx: 'load',
      },
    },
    edges: { Branch: { ends: ['from', 'to'] } },
  };
  const view = createNetwork(device, config);
  await draw(device, view);
  const measure = suite(`network ${buses} buses`, buses, () => counters(device));
  measure('first frame', async () => {
    const fresh = createNetwork(device, config);
    await draw(device, fresh);
    fresh.destroy();
  });
  measure('cached frame', () => draw(device, view));
  measure('playback frame', (i) => draw(device, view, i));
  // Before anything moves the fitted camera.
  measure('pick', () => view.pick([640, 360]));
  measure('restyle', (i) => {
    view.set({ vertices: { Bus: { radiusPx: i % 2 ? 'load' : null } } });
    return draw(device, view);
  });
  measure('camera move', (i) => {
    view.set({ camera: { scale: 1 + (i % 8) } });
    return draw(device, view);
  });
});
