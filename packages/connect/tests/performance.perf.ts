import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { pair, batch, fields } from './fixture.js';
import { defaults } from '../src/core.js';
import { preparePublication, decodePublication } from '../src/columns.js';
import { decode } from '../src/frame.js';
import type { SampleBatch } from '@latkit/model';

it.each(['rows', 'samples'] as const)(
  'streams 128 MiB of %s through native WebSocket and acceptModel',
  async (kind) => {
    const bytes = 128 * 1024 ** 2,
      elements = 32768,
      count = bytes / (elements * 8);
    const selection = kind === 'rows' ? fields : [{ from: 'Node', select: ['output'] }];
    const value = batch(elements, 7);
    const sample: SampleBatch = {
      kind: 'samples',
      index: value.index,
      rows: { kind: 'range', offset: 0, count: 4096 },
      firstFrame: 0,
      coordinates: Float64Array.from({ length: 8 }, (_, i) => i),
      columns: {
        output: {
          kind: 'numeric',
          offset: 0,
          length: elements,
          values: new Float64Array(elements).fill(7),
          rowStride: 1,
          frameStride: 4096,
        },
      },
    };
    let produced = 0,
      consumed = 0,
      maxAhead = 0;
    const startMemory = process.memoryUsage();
    const p = await pair({
      monitor: function* () {
        for (let i = 0; i < count; i++) {
          produced++;
          maxAhead = Math.max(maxAhead, produced - consumed);
          yield kind === 'rows' ? value : { ...sample, firstFrame: i * 8 };
        }
      },
    });
    let peakArrays = startMemory.arrayBuffers;
    const start = performance.now();
    try {
      for await (const publication of p.model.monitor(selection)) {
        const column = publication[0].columns[kind === 'rows' ? 'value' : 'output'];
        if (column.kind !== 'numeric') throw new Error('Wrong column');
        expect(column.values[0]).toBe(7);
        expect(column.values[elements - 1]).toBe(7);
        consumed++;
        if (consumed % 32 === 0)
          peakArrays = Math.max(peakArrays, process.memoryUsage().arrayBuffers);
      }
      const ms = performance.now() - start;
      expect(consumed).toBe(count);
      // 4 MiB window / >256 KiB message permits 15 sends plus one pending pull.
      expect(maxAhead).toBeLessThanOrEqual(16);
      console.log(
        JSON.stringify({
          kind,
          MiB: bytes / 1024 ** 2,
          ms: +ms.toFixed(1),
          MiBps: +(((bytes / 1024 ** 2) * 1000) / ms).toFixed(1),
          maxAhead,
          peakArrayBufferMiB: +(peakArrays / 1024 ** 2).toFixed(1),
        }),
      );
    } finally {
      await p.close();
    }
  },
);
it('decodes 256 MiB as typed views of received storage', () => {
  const value = batch(32768);
  const s = { types: { Node: { fields: { value: { type: 'float64' as const } } } } };
  const encoded = preparePublication(value, 1, s, defaults).encode(1),
    payload = decode(encoded, defaults).payload;
  const start = performance.now();
  for (let i = 0; i < 1024; i++) {
    const decoded = decodePublication({ bytes: payload }, s, defaults);
    const column = decoded[0].columns.value;
    if (column.kind !== 'numeric') throw new Error('Wrong column');
    expect(column.values.buffer).toBe(payload.buffer);
  }
  const ms = performance.now() - start;
  console.log(
    JSON.stringify({
      kind: 'decode-views',
      MiB: 256,
      ms: +ms.toFixed(1),
      MiBps: +(256000 / ms).toFixed(1),
    }),
  );
});
