import { describe, expect, it } from 'vitest';

import { Model } from '../src/index.js';
import { Sample, sampleClass, sampleData, sampleModel, sampleValues } from './fixture.js';

describe('model.source and Model.from', () => {
  it('round-trips a model through bytes with classes still lazy', async () => {
    const calls: string[] = [];
    const original = sampleModel(calls);
    const model = await Model.from(original.source());
    expect(calls).toEqual([]);

    expect(model.format).toBe('test');
    expect(model.name).toBe('Sample');
    expect(model.meta).toEqual({ freqBase: 60, note: 'fixture', live: true, empty: null });
    expect(model.owners).toEqual({ vertex: 'bus', edge: 'branch' });
    expect(model.topology.vertexCount).toBe(3);
    expect(model.topology.coordinateSpace).toBe('geographic');
    expect(Array.from(model.topology.vertexCoords!)).toEqual([-96, 30, -95, 31, -94, 30]);
    expect(Array.from(model.topology.edges)).toEqual([0, 1, 1, 2]);
    expect(Array.from(model.topology.polylinePoints!)).toEqual([-94.5, 30.5]);
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'branch', 'gen', 'area']);
    expect(model.class('bus')!.anchor).toBeUndefined();
    expect(Array.from(model.class('gen')!.anchor!.index)).toEqual([0, 2]);
    expect(model.class('area')!.anchor).toBeUndefined();
    expect(model.class('bus')!.signals).toEqual(original.class('bus')!.signals);
    expect(model.class('bus')!.columns).toEqual(original.class('bus')!.columns);

    const bus = await model.load('bus');
    expect(calls).toEqual(['bus']);
    expect(bus).toEqual(sampleClass('bus'));
    expect((await model.load('gen')).columns).toEqual([]);

    expect(new TextDecoder().decode(await model.bytes())).toBe('{"case":"sample"}');
  });

  it('packs only what a column declares, and every model part packs again', async () => {
    const model = await Model.from(sampleModel().source());
    const again = await Model.from(model.source());
    expect(again.class('bus')!.columns).toEqual([
      { kind: 'number', id: 'Vm', label: 'Voltage', unit: 'pu' },
      { kind: 'text', id: 'zone', label: 'Zone', group: 'Location' },
      { kind: 'flag', id: 'slack', label: 'Slack' },
    ]);
    expect(await again.load('bus')).toEqual(sampleClass('bus'));
  });

  it('hands out buffers the caller owns', async () => {
    const original = sampleModel();
    const source = original.source();
    const bytes = await source.bytes();
    bytes[0] = 0;
    expect((await original.bytes())[0]).toBe(0x7b);
    const core = await source.core();
    expect(core.byteOffset).toBe(0);
    expect(core.byteLength).toBe(core.buffer.byteLength);
  });

  it('reads sections as views into the received buffer', async () => {
    const core = await sampleModel().source().core();
    const model = await Model.from({ ...stub(), core: async () => core });
    expect(model.topology.edges.buffer).toBe(core.buffer);
  });

  it('rejects a core that is not a pack or describes an inconsistent model', async () => {
    await expect(Model.from({ ...stub(), core: async () => new Uint8Array(3) })).rejects.toThrow(
      /truncated/,
    );
    await expect(
      Model.from({ ...stub(), core: async () => new TextEncoder().encode('LKM\0garbage.....') }),
    ).rejects.toThrow();
  });

  it('rejects a shard that does not hold the columns its spec declares', async () => {
    const packed = sampleModel().source();
    const shard = await packed.class('gen');
    const model = await Model.from({ ...stub(), core: packed.core, class: async () => shard });
    await expect(model.load('bus')).rejects.toThrow(/does not hold the columns its spec declares/);
    // The same columns in another order: every count agrees, every column is misplaced.
    const swap = <T>([first, second, ...rest]: readonly T[]): T[] => [second!, first!, ...rest];
    const reordered = new Sample({
      description: {
        ...sampleData(),
        classes: sampleData().classes.map((spec) =>
          spec.id === 'bus' ? { ...spec, columns: swap(spec.columns) } : spec,
        ),
      },
      values: async (id) => {
        const values = sampleValues(id);
        return id === 'bus' ? { ...values, values: swap(values.values) } : values;
      },
    });
    const swapped = await reordered.source().class('bus');
    const other = await Model.from({ ...stub(), core: packed.core, class: async () => swapped });
    await expect(other.load('bus')).rejects.toThrow(/does not hold the columns/);
  });

  it('refuses a core read once aborted, and forwards abort signals and progress', async () => {
    await expect(sampleModel().source().core(AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    const seen: string[] = [];
    const packed = sampleModel().source();
    const source: Model.Source = {
      core: async (signal, progress) => {
        seen.push(`core:${signal?.aborted ?? 'none'}`);
        progress?.(1, 2);
        return packed.core();
      },
      class: async (id, signal) => {
        seen.push(`class:${id}:${signal?.aborted ?? 'none'}`);
        return packed.class(id);
      },
      bytes: async () => new Uint8Array(),
    };
    const progress: [number, number][] = [];
    const model = await Model.from(source, {
      signal: new AbortController().signal,
      progress: (loaded, total) => progress.push([loaded, total]),
    });
    await model.load('bus');
    expect(seen).toEqual(['core:false', 'class:bus:false']);
    expect(progress).toEqual([[1, 2]]);
  });
});

function stub(): Model.Source {
  return {
    core: async () => new Uint8Array(),
    class: async () => new Uint8Array(),
    bytes: async () => new Uint8Array(),
  };
}
