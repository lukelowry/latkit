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
  // A wider color domain, as a live run's extremes grow: the same reads, new uniforms.
  measure('recolor', (i) => {
    view.set({
      vertices: {
        Bus: { color: { field: 'voltage', domain: [0.95 - i * 1e-3, 1.05 + i * 1e-3] } },
      },
    });
    return draw(device, view);
  });
  measure('camera move', (i) => {
    view.set({ camera: { scale: 1 + (i % 8) } });
    return draw(device, view);
  });
});

// Positions from layout alone: stress places every bus by its branches once, then frames reuse it.
describe.each(sizes.filter((buses) => buses <= 100_000))(
  'network %i buses unpositioned',
  async (buses) => {
    const device = await gpu(),
      config: NetworkConfig = {
        source: grid(buses),
        vertices: { Bus: { radiusPx: 'load' } },
        edges: { Branch: { ends: ['from', 'to'] } },
      };
    const view = createNetwork(device, config);
    await draw(device, view);
    const measure = suite(`network ${buses} buses unpositioned`, buses, () => counters(device));
    measure('first frame', async () => {
      const fresh = createNetwork(device, config);
      await draw(device, fresh);
      fresh.destroy();
    });
    measure('cached frame', () => draw(device, view));
    measure('restyle', (i) => {
      view.set({ vertices: { Bus: { radiusPx: i % 2 ? 'load' : null } } });
      return draw(device, view);
    });
  },
);
