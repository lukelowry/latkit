import { afterAll, describe } from 'vitest';
import { protocol } from '@latkit/connect';
import { connected, schema, sizes, split, suite, voltages } from './harness.ts';

const bounds = { messageBytes: 64 << 20, metadataBytes: 64 << 10, publicationBatches: 64 };

describe.each(sizes)('connect %i buses', async (buses) => {
  const frame = voltages(buses, 0),
    payload = protocol.decode(
      protocol.preparePublication(frame, 1, schema, bounds).encode(1),
      bounds,
    ).payload;
  let blocks = 0;
  const { model, close } = await connected(function* (_fields, context) {
    const parts = split(frame, Math.floor((context.maxBlockBytes - 4096) / 4));
    blocks = parts.length;
    for (let f = 0; !context.signal.aborted; f++)
      for (const part of parts) yield { ...part, firstFrame: f, coordinates: Float64Array.of(f) };
  });
  const stream = model.monitor!([{ from: 'Bus', select: ['voltage'] }]);
  await stream.next();
  afterAll(close);
  const measure = suite(`connect ${buses} buses`, buses);
  measure('encode frame', () => protocol.preparePublication(frame, 1, schema, bounds).encode(1));
  measure('decode frame', () => protocol.decodePublication({ bytes: payload }, schema, bounds));
  measure('stream frame', async () => {
    for (let read = 0; read < blocks; read++) await stream.next();
  });
});
