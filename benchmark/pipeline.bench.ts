import { afterAll, describe } from 'vitest';
import { createComposition } from '@latkit/gpu';
import { appendData, type SampleBatch } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
import {
  connected,
  counters,
  draw,
  frames,
  gpu,
  grid,
  sizes,
  split,
  suite,
  voltages,
} from './harness.ts';

/**
 * The integrated path for one published frame: a producer publishes it over a WebSocket, the host
 * appends it to its data, and a network and a monitor composed on one canvas draw it.
 */
describe.each(sizes)('pipeline %i buses', async (buses) => {
  const device = await gpu(),
    frame = voltages(buses, 0);
  let data = grid(buses),
    blocks = 0;
  const { model, close } = await connected(function* (_fields, context) {
    const parts = split(frame, Math.floor((context.maxBlockBytes - 4096) / 4));
    blocks = parts.length;
    for (let f = frames; !context.signal.aborted; f++)
      for (const part of parts) yield { ...part, firstFrame: f, coordinates: Float64Array.of(f) };
  });
  const stream = model.monitor!([{ from: 'Bus', select: ['voltage'] }]);
  const network = createNetwork(device, {
    source: data,
    vertices: { Bus: { color: { field: 'voltage', domain: [0.95, 1.05] } } },
    edges: { Branch: { ends: ['from', 'to'] } },
  });
  // A fixed window with room for the run, as a model that declares its domain gives.
  const monitor = createMonitor(device, {
    source: data,
    traces: {
      voltage: { from: 'Bus', field: 'voltage', rows: { kind: 'range', offset: 0, count: 100 } },
    },
    camera: { window: [0, frames * 4] },
  });
  const composition = createComposition(device, {
    views: [
      { view: network, region: [0, 0, 1, 0.6] },
      { view: monitor, region: [0, 0.6, 1, 0.4] },
    ],
  });
  await draw(device, composition, frames - 1, 'complete');
  afterAll(async () => {
    composition.destroy();
    network.destroy();
    monitor.destroy();
    await close();
  });
  const measure = suite(`pipeline ${buses} buses`, buses, () => counters(device));
  measure('publication to frame', async () => {
    const batches: SampleBatch[] = [];
    do batches.push(...((await stream.next()).value as SampleBatch[]));
    while (batches.length < blocks);
    data = appendData(data, batches);
    network.set({ source: data });
    monitor.set({ source: data });
    await draw(device, composition, batches[0].firstFrame);
  });
});
