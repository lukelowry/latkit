import { describe } from 'vitest';
import { kit } from '@latkit/gpu';
import { counters, draw, gpu, suite } from './harness.ts';

describe('gpu text 1000 labels', async () => {
  const device = await gpu();
  const runs = Array.from({ length: 1000 }, (_, i) => ({
    text: 'Bus ' + i,
    size: 12,
    position: [0, i * 16] as const,
  }));
  const text: kit.Renderer = {
    capture: () => ({
      prepare: async (frame) => {
        await frame.text({ runs });
        return { encode() {}, submitted() {}, discard() {} };
      },
      release() {},
    }),
    destroy() {},
  };
  const measure = suite('gpu text 1000 labels', 1000, () => counters(device), 8);
  measure('cold text', () => {
    device.trim();
    return draw(device, text);
  });
  measure('resident text', () => draw(device, text));
});
