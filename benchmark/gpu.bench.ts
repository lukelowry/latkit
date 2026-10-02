import { describe } from 'vitest';
import { kit } from '@latkit/gpu';
import type { Data, FieldInput } from '@latkit/model';
import { draw, frames, gpu, grid, sizes, suite } from './harness.ts';

/** A renderer that reads fields and uploads them each frame, as every view does. */
function uploads(data: Data, fields: Readonly<Record<string, FieldInput>>): kit.Renderer {
  return {
    capture: () => ({
      prepare: async (frame) => {
        for await (const block of frame.reader.fields({ source: data, from: 'Bus', fields }))
          frame.upload(block, { select: Object.keys(fields) });
        return { encode() {}, submitted() {}, discard() {} };
      },
      release() {},
    }),
    destroy() {},
  };
}

describe.each(sizes)('gpu %i buses', async (buses) => {
  const device = await gpu(),
    data = grid(buses);
  const staticFields = uploads(data, { load: 'load', position: 'position' }),
    sampled = uploads(data, { voltage: 'voltage' });
  const measure = suite(`gpu ${buses} buses`, buses, () => device.stats());
  measure('cold upload', () => {
    device.trim();
    return draw(device, staticFields);
  });
  measure('resident redraw', () => draw(device, staticFields));
  measure('playback frame', (i) => draw(device, sampled, i));
  measure('field scale', async () => {
    const scope = device.reader.open();
    try {
      return await kit.fieldScale(scope, {
        source: data,
        from: 'Bus',
        field: 'voltage',
        window: { kind: 'range', between: [0, frames - 1] },
      });
    } finally {
      scope.close();
    }
  });
});
