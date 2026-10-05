import { expect, it } from 'vitest';
import type { FieldsBlock, FieldValues } from '@latkit/model';
import {
  bindChannels,
  channelOn,
  resolveChannel,
  channelValue,
  resolveScale,
  writeChannel,
  type GpuField,
} from '../src/kit.js';

const KINDS = { x: 'raw', y: 'raw', size: [2, 8], color: 'color', visible: 'raw' } as const;

it('binds constants, fields, lanes, and scales, sharing one column per field', () => {
  const position: FieldValues = {
    index: { source: 's', type: 'T', version: '1' },
    rows: { kind: 'range', offset: 0, count: 0 },
    values: { kind: 'numeric', offset: 0, length: 0, values: new Float64Array() },
  };
  const { fields, channels } = bindChannels(
    {
      x: { field: position, component: 0 },
      y: { field: position, component: 1 },
      size: 'load',
      color: { field: 'load', colormap: 'viridis', missing: [1, 0, 0, 1] },
      visible: false,
    },
    KINDS,
  );
  // One column per distinct field, named by the first channel reading it.
  expect(fields).toEqual({ x: position, size: 'load' });
  expect(channels.x).toEqual({ field: position, component: 0, column: 'x' });
  expect(channels.y).toMatchObject({ column: 'x', component: 1 });
  expect(channels.y.scale).toBeUndefined();
  expect(channels.size).toMatchObject({ column: 'size', scale: { range: [2, 8] } });
  expect(channels.color).toMatchObject({
    column: 'size',
    color: true,
    scale: { range: [0, 1] },
    colormap: 'viridis',
    missing: [1, 0, 0, 1],
  });
  expect(channels.visible).toEqual({ component: 0, constant: 0 });
  // A raw channel maps only when given a range; a scaled one takes its own range by default.
  expect(
    bindChannels({ x: { field: 'lon', range: [0, 1] }, size: { field: 'w' } }, KINDS).channels,
  ).toMatchObject({ x: { scale: { range: [0, 1] } }, size: { scale: { range: [2, 8] } } });
  expect(bindChannels({ color: [0.1, 0.2, 0.3, 1] }, KINDS).channels.color.constant).toEqual([
    0.1, 0.2, 0.3, 1,
  ]);
  for (const bad of [{ size: NaN }, { size: [1, 2, 3, 4] }, { color: 3 }, { x: '' }])
    expect(() => bindChannels(bad, KINDS)).toThrow();
  expect(() => bindChannels({ x: { field: 'p', component: 1.5 } }, KINDS)).toThrow();
  expect(() => bindChannels({ color: { field: 'p', missing: [2, 0, 0, 1] } }, KINDS)).toThrow();
});

it('reads a row as the shader does: lanes, booleans, presence, scales, and the fallback', () => {
  const block = {
    rows: { kind: 'range', offset: 0, count: 3 },
    presence: { x: Uint8Array.of(0b011) },
    columns: {
      x: {
        kind: 'vector',
        size: 2,
        offset: 0,
        length: 3,
        values: {
          kind: 'numeric',
          offset: 0,
          length: 6,
          values: Float64Array.of(1, 2, 3, 4, 5, 6),
        },
      },
      on: { kind: 'boolean', offset: 0, length: 3, values: Uint8Array.of(0b101) },
      load: {
        kind: 'numeric',
        offset: 0,
        length: 3,
        validity: Uint8Array.of(0b110),
        values: Float32Array.of(0, 5, 10),
      },
    },
  } as unknown as FieldsBlock;
  const y = resolveChannel({ column: 'x', component: 1 }, undefined, Infinity);
  expect([0, 1, 2].map((row) => channelValue(y, block, row))).toEqual([2, 4, Infinity]);
  const on = resolveChannel({ column: 'on', component: 0 }, undefined, 1);
  expect([0, 1, 2].map((row) => channelValue(on, block, row))).toEqual([1, 0, 1]);
  expect([0, 1, 2].map((row) => channelOn(on, block, row))).toEqual([true, false, true]);
  // A boolean channel is on only where positive.
  expect(channelOn(resolveChannel({ component: 0, constant: -1 }, null, 1), block, 0)).toBe(false);
  // A scale's `missing` fills rows its field leaves empty.
  const missing = resolveChannel(
    { column: 'load', component: 0, scale: { range: [2, 8] }, missing: 1 },
    resolveScale({ range: [2, 8] }, [0, 10]),
    4,
  );
  expect(channelValue(missing, block, 0)).toBe(1);
  const size = resolveChannel(
    { column: 'load', component: 0, scale: { range: [2, 8] } },
    resolveScale({ range: [2, 8] }, [0, 10]),
    4,
  );
  expect([0, 1, 2].map((row) => channelValue(size, block, row))).toEqual([4, 5, 8]);
  // A scale whose domain is unknown, and a constant, read their fallbacks.
  const unknown = resolveChannel(
    { column: 'load', component: 0, scale: { range: [2, 8] } },
    null,
    3,
  );
  expect(channelValue(unknown, block, 1)).toBe(3);
  expect(channelValue(resolveChannel({ component: 0, constant: 7 }, null, 3), block, 1)).toBe(7);
});

it('writes a channel as a field shader reads it: slot, lane, mapping, origin, and fallback', () => {
  const words = new Uint32Array(8),
    floats = new Float32Array(words.buffer);
  const field: GpuField = {
    kind: 'value',
    slot: 3,
    type: 'float32',
    components: 2,
    origin: Float64Array.of(1e12, 5),
  };
  // A relative Float64 scale maps from its rebased domain.
  writeChannel(
    words,
    0,
    resolveChannel(
      { column: 'p', component: 0, scale: { range: [2, 0] } },
      resolveScale({ range: [2, 0] }, [1e12, 1e12 + 1]),
      -1,
    ),
    field,
  );
  expect([...floats.slice(0, 4)]).toEqual([0, 1, 2, -2]);
  expect([words[4], words[5], floats[7]]).toEqual([3, 1 | 4, -1]);
  // A raw lane adds its own origin, or the one the view rebases to.
  writeChannel(words, 0, resolveChannel({ column: 'p', component: 1 }, null, 0), field);
  expect([words[5], floats[6]]).toEqual([1 << 4, 5]);
  writeChannel(words, 0, resolveChannel({ column: 'p', component: 1 }, null, 0), field, 0);
  expect(floats[6]).toBe(0);
  // Without a field, the shader reads only the fallback.
  writeChannel(words, 0, resolveChannel({ component: 0, constant: 9 }, null, 0), undefined);
  expect([words[4], words[5] & 3, floats[7]]).toEqual([0xffffffff, 3, 9]);
  expect(() =>
    writeChannel(words, 0, resolveChannel({ column: 'p', component: 2 }, null, 0), field),
  ).toThrow();
});
