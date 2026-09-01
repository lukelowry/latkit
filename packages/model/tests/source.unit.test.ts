import { describe, expect, it } from 'vitest';

import { openModel, sourceOf, type Source } from '../src/index.js';
import { sampleClass, sampleModel } from './fixture.js';

describe('sourceOf and openModel', () => {
  it('round-trips a model through bytes with classes still lazy', async () => {
    const calls: string[] = [];
    const source = sourceOf(sampleModel(calls));
    const model = await openModel(source);
    expect(calls).toEqual([]);

    expect(model.vendor).toBe('test');
    expect(model.name).toBe('Sample');
    expect(model.meta).toEqual({ freqBase: 60, note: 'fixture', live: true, empty: null });
    expect(model.owners).toEqual({ vertex: 'bus', edge: 'branch' });
    expect(model.topology.vertexCount).toBe(3);
    expect(model.topology.coordinateSpace).toBe('geographic');
    expect(Array.from(model.topology.vertexCoords!)).toEqual([-96, 30, -95, 31, -94, 30]);
    expect(Array.from(model.topology.edges)).toEqual([0, 1, 1, 2]);
    expect(Array.from(model.topology.polylinePoints!)).toEqual([-94.5, 30.5]);
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'branch', 'gen', 'area']);
    expect(model.classes[0]!.anchor).toBeUndefined();
    expect(Array.from(model.classes[2]!.anchor!.index)).toEqual([0, 2]);
    expect(model.classes[3]!.anchor).toBeUndefined();
    expect(model.classes[0]!.signals).toEqual(sampleModel().classes[0]!.signals);

    const bus = await model.load('bus');
    expect(calls).toEqual(['bus']);
    const expected = sampleClass('bus');
    expect(bus.labels).toEqual(expected.labels);
    expect(bus.columns.map((column) => column.kind)).toEqual(['number', 'text', 'flag']);
    expect(Array.from(bus.columns[0]!.values as Float64Array)).toEqual([1.02, NaN, 0.98]);
    expect(bus.columns[0]).toMatchObject({ unit: 'pu' });
    expect(bus.columns[1]).toMatchObject({ group: 'Location', values: ['A', null, 'B'] });
    expect(Array.from(bus.columns[2]!.values as Uint8Array)).toEqual([1, 0, 0]);
    expect((await model.load('gen')).columns).toEqual([]);

    expect(new TextDecoder().decode(await model.bytes())).toBe('{"case":"sample"}');
  });

  it('hands out buffers the caller owns', async () => {
    const original = sampleModel();
    const source = sourceOf(original);
    const bytes = await source.bytes();
    bytes[0] = 0;
    expect((await original.bytes())[0]).toBe(0x7b);
    const core = await source.core();
    expect(core.byteOffset).toBe(0);
    expect(core.byteLength).toBe(core.buffer.byteLength);
  });

  it('reads sections as views into the received buffer', async () => {
    const core = await sourceOf(sampleModel()).core();
    const model = await openModel({ ...stub(), core: async () => core });
    expect(model.topology.edges.buffer).toBe(core.buffer);
  });

  it('rejects a core that is not a pack or describes an inconsistent model', async () => {
    await expect(openModel({ ...stub(), core: async () => new Uint8Array(3) })).rejects.toThrow(
      /truncated/,
    );
    await expect(
      openModel({ ...stub(), core: async () => new TextEncoder().encode('LKM\0garbage.....') }),
    ).rejects.toThrow();
    const core = await sourceOf(sampleModel()).core();
    const flipped = core.slice();
    flipped[5] = 9; // version
    await expect(openModel({ ...stub(), core: async () => flipped })).rejects.toThrow(/version/);
  });

  it('rejects a shard that does not match its spec', async () => {
    const shard = await sourceOf(sampleModel()).class('gen');
    const source: Source = {
      ...stub(),
      core: sourceOf(sampleModel()).core,
      class: async () => shard,
    };
    const model = await openModel(source);
    await expect(model.load('bus')).rejects.toThrow(/one label per element/);
  });

  it('forwards abort signals and progress', async () => {
    const seen: string[] = [];
    const source: Source = {
      core: async (signal, progress) => {
        seen.push(`core:${signal?.aborted ?? 'none'}`);
        progress?.(1, 2);
        return sourceOf(sampleModel()).core();
      },
      class: async (id, signal) => {
        seen.push(`class:${id}:${signal?.aborted ?? 'none'}`);
        return sourceOf(sampleModel()).class(id);
      },
      bytes: async () => new Uint8Array(),
    };
    const progress: [number, number][] = [];
    const model = await openModel(source, {
      signal: new AbortController().signal,
      progress: (loaded, total) => progress.push([loaded, total]),
    });
    await model.load('bus');
    expect(seen).toEqual(['core:false', 'class:bus:false']);
    expect(progress).toEqual([[1, 2]]);
  });
});

function stub(): Source {
  return {
    core: async () => new Uint8Array(),
    class: async () => new Uint8Array(),
    bytes: async () => new Uint8Array(),
  };
}
