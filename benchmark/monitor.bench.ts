import { describe } from 'vitest';
import { appendData } from '@latkit/model';
import { createMonitor, type MonitorConfig } from '@latkit/monitor';
import { counters, draw, frames, gpu, grid, suite, voltages } from './harness.ts';

/** A trace per row: monitors scale with the rows they draw. */
describe.each([100, 1_000, 10_000])('monitor %i rows', async (rows) => {
  const device = await gpu();
  let data = grid(rows);
  // A fixed window with room for the stream, as a run that declares its domain uses.
  const config: MonitorConfig = {
    source: data,
    traces: { voltage: { from: 'Bus', y: 'voltage' } },
    camera: { window: [0, frames * 4] },
  };
  const view = createMonitor(device, config);
  await draw(device, view, 0, 'complete');
  const measure = suite(`monitor ${rows} rows`, rows, () => counters(device), 12);
  measure('first frame', async () => {
    const fresh = createMonitor(device, config);
    await draw(device, fresh, 0, 'complete');
    fresh.destroy();
  });
  measure('cached frame', () => draw(device, view));
  // Moving the playhead never reads history again.
  measure('playhead', (i) => draw(device, view, i % frames));
  // A quarter in: inside the recorded frames of the wide window.
  measure('pick', () => view.pick([280, 360], { radiusPx: 24 }));
  // Each new frame draws alone, joined to the last.
  measure('stream frame', async (i) => {
    data = appendData(data, [voltages(rows, frames + i)]);
    view.set({ source: data });
    await draw(device, view, frames + i, 'complete');
  });
  // A new window redraws history behind the shown image.
  measure('change window', async (i) => {
    view.set({ camera: { window: [0, frames * 4 + 1 + (i % 2)] } });
    await draw(device, view, 0, 'complete');
  });
});
