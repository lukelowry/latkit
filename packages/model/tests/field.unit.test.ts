import { describe, expect, it } from 'vitest';

import { createSeries, extent, type Recording, validateDomain } from '../src/index.js';
import { sampleModel } from './fixture.js';

describe('field', () => {
  it('resolves a number column to a sealed series of one frame that holds at every time', async () => {
    const model = sampleModel();
    const vm = (await model.field({ classId: 'bus', kind: 'column', id: 'Vm' }))!;
    expect(vm).toMatchObject({
      ref: { classId: 'bus', kind: 'column', id: 'Vm' },
      label: 'Voltage',
      unit: 'pu',
      signal: 0,
      domain: [0.98, 1.02],
    });
    expect(vm.series.signals).toEqual(['Vm']);
    expect(vm.series.state).toMatchObject({ frameCount: 1, live: false });
    for (const time of [-5, 0, 1e9]) expect([...(await vm.at(time))]).toEqual([1.02, NaN, 0.98]);
    await expect(vm.at(Number.NaN)).rejects.toThrow(RangeError);
  });

  it('resolves one reference to one series, so renderers share its frames', async () => {
    const model = sampleModel();
    const ref = { classId: 'bus', kind: 'column', id: 'Vm' } as const;
    const [a, b] = await Promise.all([model.field(ref), model.field(ref)]);
    expect(a!.series).toBe(b!.series);
    expect((await model.field(ref))!.series).toBe(a!.series);
  });

  it('resolves a signal against a recording, reading at its clock and growing its domain', async () => {
    const model = sampleModel();
    const recording = model.record({ id: 'run' });
    const vm = (await model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, recording))!;
    expect(vm).toMatchObject({ label: 'Voltage', unit: 'pu', signal: 0, domain: [0, 1] });
    expect(vm.series).toBe(await recording.series('bus'));
    expect([...(await vm.at(3))]).toEqual([NaN, NaN, NaN]);

    recording.append({
      time: Float64Array.of(0, 1),
      values: { bus: Float32Array.of(1, 2, 3, 4, 5, 6) },
    });
    expect([...(await vm.at(-1))]).toEqual([1, 2, 3]);
    expect([...(await vm.at(0.5))]).toEqual([1, 2, 3]);
    expect([...(await vm.at(7))]).toEqual([4, 5, 6]);
    expect(vm.domain).toEqual([1, 6]);
    await expect(vm.at(1, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('spreads a sparse series over every element of its class', async () => {
    const model = sampleModel();
    const sparse = createSeries({
      signals: ['Vm'],
      elementCount: 2,
      elements: Uint32Array.of(0, 2),
      time: Float64Array.of(0),
      values: Float64Array.of(7, 9),
    });
    const recording: Recording = {
      ...model.record({ id: 'sparse' }),
      frameAt: () => 0,
      series: async () => sparse,
    };
    const vm = (await model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, recording))!;
    const dense = await vm.at(0);
    expect(dense).toBeInstanceOf(Float64Array);
    expect([...dense]).toEqual([7, NaN, 9]);
  });

  it('resolves nothing it has no values for', async () => {
    const model = sampleModel();
    const recording = model.record({ id: 'run' });
    const none = [
      model.field({ classId: 'nope', kind: 'column', id: 'Vm' }),
      model.field({ classId: 'bus', kind: 'column', id: 'nope' }),
      model.field({ classId: 'bus', kind: 'column', id: 'zone' }),
      model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }),
      model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, null),
      model.field({ classId: 'bus', kind: 'signal', id: 'Va' }, recording),
      model.field({ classId: 'area', kind: 'signal', id: 'P' }, recording),
    ];
    expect(await Promise.all(none)).toEqual(Array(none.length).fill(null));
    await expect(model.field({ classId: 'bus', kind: 'value', id: 'Vm' } as never)).rejects.toThrow(
      TypeError,
    );
    await expect(
      model.field({ classId: 'bus', kind: 'column', id: 'Vm' }, null, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('domain', () => {
  it('scans the finite extent and reports null when nothing is finite', () => {
    expect(extent(Float32Array.of(Number.NaN, -2, 5, Infinity))).toEqual([-2, 5]);
    expect(extent(Float64Array.of(3))).toEqual([3, 3]);
    expect(extent([Number.NaN, Infinity])).toBeNull();
    expect(extent([])).toBeNull();
  });

  it.each([
    [0, 1],
    [-10, -2],
    [3, 3],
  ] as const)('accepts the finite ordered domain [%s, %s]', (minimum, maximum) => {
    expect(() => validateDomain([minimum, maximum])).not.toThrow();
  });

  it.each([
    [null, TypeError],
    [[0], TypeError],
    [[0, 1, 2], TypeError],
    [['0', 1], TypeError],
    [[0, Number.NaN], RangeError],
    [[Number.NEGATIVE_INFINITY, 1], RangeError],
    [[2, 1], RangeError],
  ] as const)('rejects invalid domain %# with the semantic error class', (value, ErrorType) => {
    expect(() => validateDomain(value)).toThrow(ErrorType);
  });

  it('names the domain in the failure without mutating the input', () => {
    const domain = [2, 1];
    expect(() => validateDomain(domain, 'vertex height range')).toThrow(
      'vertex height range minimum must not exceed its maximum',
    );
    expect(domain).toEqual([2, 1]);
  });
});
