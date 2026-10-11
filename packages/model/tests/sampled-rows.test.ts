import { expect, it } from 'vitest';
import { appendData, createData, createReader, textColumn } from '../src/index.js';

it('reads static and sampled fields of explicit rows at every coordinate a playback passes', async () => {
  const count = 30,
    frames = 301,
    dt = 1 / 30,
    index = { source: 'case', type: 'Machine', version: '1' };
  const numeric = (values: Float32Array) => ({
    kind: 'numeric' as const,
    offset: 0,
    length: values.length,
    values,
  });
  let data = createData(
    {
      axis: { name: 'Time' },
      types: {
        Machine: {
          fields: {
            power: { type: 'float32' },
            speed: { type: 'float32', sampled: true },
          },
        },
      },
    },
    [
      {
        kind: 'rows',
        index,
        rows: { kind: 'range', offset: 0, count },
        ids: textColumn(Array.from({ length: count }, (_, i) => 'm' + i)),
        columns: { power: numeric(new Float32Array(count).fill(1)) },
      },
    ],
  );
  data = appendData(data, [
    {
      kind: 'samples',
      index,
      rows: { kind: 'range', offset: 0, count },
      firstFrame: 0,
      coordinates: Float64Array.from({ length: frames }, (_, f) => f * dt),
      columns: {
        speed: {
          ...numeric(Float32Array.from({ length: frames * count }, (_, i) => i)),
          frameStride: count,
          rowStride: 1,
        },
      },
    },
  ]);
  const reader = createReader();
  // A playback may land just before the first frame, where no row has a value yet.
  for (let step = -2; step < 240; step++) {
    const at = step * 0.004167;
    const scope = reader.open({ at });
    try {
      let rows = 0;
      for await (const tile of scope.fields({
        source: data,
        from: 'Machine',
        rows: { kind: 'range', offset: 0, count, index },
        fields: { color: 'speed', radiusPx: 'power' },
      })) {
        rows += tile.columns.radiusPx.length;
        // Before the first frame every row is absent; after it, every row is present.
        expect(tile.presence.color === undefined).toBe(at >= 0);
        if (tile.presence.color)
          expect([...tile.presence.color].every((bits) => bits === 0)).toBe(true);
      }
      expect(rows).toBe(count);
    } finally {
      scope.close();
    }
  }
  reader.destroy();
});
