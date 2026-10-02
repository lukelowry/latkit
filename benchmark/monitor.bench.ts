import { describe } from 'vitest';
import { appendData } from '@latkit/model';
import { createMonitor, type MonitorConfig } from '@latkit/monitor';
import { draw, frames, gpu, grid, suite, voltages } from './harness.ts';

/** A trace per row: monitors scale with the rows they draw. */
describe.each([100, 1_000, 10_000])('monitor %i rows', async (rows) => {
  const device = await gpu();
  let data = grid(rows);
  const config: MonitorConfig = {
    source: data,
    traces: { voltage: { from: 'Bus', field: 'voltage' } },
    camera: { window: [0, frames - 1] },
    // Refine history in one pass, so the work each frame does is exact.
    limits: { frameMs: 60_000 },
  };
  const view = createMonitor(device, config);
  await draw(device, view, 0, 'complete');
  // Refinement sizes its steps by elapsed time, so only reads are exact: the work that matters is
  // never reading history again.
  const measure = suite(
    `monitor ${rows} rows`,
    rows,
    () => {
      const { queries, queryHits, evictions } = device.stats();
      return { queries, queryHits, evictions };
    },
    12,
  );
  measure('first frame', async () => {
    const fresh = createMonitor(device, config);
    await draw(device, fresh, 0, 'complete');
    fresh.destroy();
  });
  measure('cached frame', () => draw(device, view));
  // Moving the playhead never rereads history.
  measure('playhead', (i) => draw(device, view, i % frames));
  measure('pick', () => view.pick([640, 360]));
  measure('zoom window', async (i) => {
    view.set({ camera: { window: [0, 8 + (i % 16)] } });
    await draw(device, view, 0, 'complete');
  });
  measure('append and follow', async (i) => {
    data = appendData(data, [voltages(rows, frames + i)]);
    view.set({ source: data, camera: { follow: frames } });
    await draw(device, view, frames + i, 'complete');
  });
});
