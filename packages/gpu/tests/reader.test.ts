import { expect, it } from 'vitest';
import { createNativeReader } from '../src/reader.js';
import { FieldSource } from './fixtures/field-source.js';
it('resolves indexed native fields and releases CPU-only sessions', async () => {
  const source = new FieldSource(),
    reader = createNativeReader();
  try {
    for await (const tile of reader.fields({
      source: source.data,
      from: source.index.type,
      rows: { index: source.index, kind: 'range', offset: 0, count: 8 },
      fields: { position: 'position', value: 'value' },
    })) {
      expect(tile.columns.position.kind).toBe('vector');
      expect(tile.index).toEqual(source.index);
    }
    reader.check();
  } finally {
    reader.destroy();
    reader.destroy();
  }
  await expect(async () => {
    for await (const _tile of reader.fields({
      source: source.data,
      from: source.index.type,
      fields: { value: 'value' },
    })) {
      throw new Error('Canceled reader yielded data');
    }
  }).rejects.toMatchObject({ name: 'AbortError' });
});
it('rejects canceled reads without acquiring a WebGPU device', async () => {
  const controller = new AbortController();
  controller.abort();
  const reader = createNativeReader({ signal: controller.signal }),
    source = new FieldSource();
  try {
    await expect(async () => {
      for await (const _tile of reader.fields({
        source: source.data,
        from: source.index.type,
        fields: { value: 'value' },
      })) {
        throw new Error('Canceled reader yielded data');
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    reader.destroy();
  }
});
