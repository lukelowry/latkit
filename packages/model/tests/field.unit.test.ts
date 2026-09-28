import { describe, expect, it, vi } from 'vitest';

import { extent, Recording, Series, validateDomain } from '../src/index.js';
import { fieldOf } from '../src/field.js';
import { byHand, sampleModel } from './fixture.js';

const NONE = 0xffffffff;
const always = (): number => 0;

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
    const { recording, recorder } = byHand(model);
    const vm = (await model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, recording))!;
    expect(vm).toMatchObject({ label: 'Voltage', unit: 'pu', signal: 0, domain: [0, 1] });
    expect(vm.series).toBe(recording.series('bus'));
    expect([...(await vm.at(3))]).toEqual([NaN, NaN, NaN]);

    recorder.append(Float64Array.of(0, 1), { bus: Float32Array.of(1, 2, 3, 4, 5, 6) });
    expect([...(await vm.at(-1))]).toEqual([1, 2, 3]);
    expect([...(await vm.at(0.5))]).toEqual([1, 2, 3]);
    expect([...(await vm.at(7))]).toEqual([4, 5, 6]);
    expect(vm.domain).toEqual([1, 6]);
    await expect(vm.at(1, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('spreads a sparse series over every element of its class', async () => {
    const model = sampleModel();
    const mirror = await Recording.from({
      describe: async () => ({
        id: 'sparse',
        label: 'Sparse',
        classes: [
          { classId: 'bus', signals: ['Vm'], elementCount: 2, elements: Uint32Array.of(0, 2) },
        ],
      }),
      async *changes() {
        yield {
          time: Float64Array.of(0),
          ranges: { bus: Float64Array.of(7, 9) },
          status: 'complete' as const,
          ahead: 0,
          error: null,
          span: null,
          expectedFrames: null,
          log: [],
        };
      },
      read: async () => ({ time: Float64Array.of(0), values: Float64Array.of(7, 9), stride: 2 }),
    });
    const vm = (await model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, mirror))!;
    const dense = await vm.at(0);
    expect(dense).toBeInstanceOf(Float64Array);
    expect([...dense]).toEqual([7, NaN, 9]);
  });

  it('resolves nothing it has no values for', async () => {
    const model = sampleModel();
    const { recording } = byHand(model);
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

describe('field.gather', () => {
  async function recorded() {
    const model = sampleModel();
    const { recording, recorder } = byHand(model);
    recorder.append(Float64Array.of(0, 1), { bus: Float32Array.of(1, 2, 3, 4, 5, 6) });
    const vm = (await model.field({ classId: 'bus', kind: 'signal', id: 'Vm' }, recording))!;
    return { recorder, vm };
  }

  it('holds each item its element, NaN for none, on the field clock and range', async () => {
    const { recorder, vm } = await recorded();
    const nets = vm.gather([2, 0, NONE, 2]);
    expect(nets).toMatchObject({ ref: vm.ref, label: 'Voltage', unit: 'pu', signal: 0 });
    expect(nets.series.signals).toEqual(['Vm']);
    expect(nets.series.elementCount).toBe(4);
    expect(nets.series.state).toMatchObject({ frameCount: 2, timeRange: [0, 1], live: true });
    expect([...nets.series.state.ranges!]).toEqual([1, 6]);
    expect(nets.domain).toEqual(vm.domain);
    expect([...(await nets.at(0))]).toEqual([3, 1, NaN, 3]);
    expect([...(await nets.at(1))]).toEqual([6, 4, NaN, 6]);

    const block = await nets.series.read(0, {
      frameOffset: 0,
      frameCount: 2,
      elementOffset: 1,
      elementCount: 3,
    });
    expect([...block.time]).toEqual([0, 1]);
    expect(block.stride).toBe(3);
    expect([...block.values]).toEqual([1, NaN, 3, 4, NaN, 6]);
    expect(await nets.series.locate([0.5, 1], 2)).toEqual([1, 2]);

    const state = nets.series.state;
    expect(nets.series.state).toBe(state);
    const changed = vi.fn();
    nets.series.on('change', changed);
    recorder.append(Float64Array.of(2), { bus: Float32Array.of(7, 8, 9) });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(nets.series.state).not.toBe(state);
    expect(nets.series.state.frameCount).toBe(3);
    expect([...(await nets.at(2))]).toEqual([9, 7, NaN, 9]);
  });

  it('reads times alone for items that hold nothing, and gathers what it gathered', async () => {
    const { vm } = await recorded();
    expect([...(await vm.gather([NONE, NONE]).at(1))]).toEqual([NaN, NaN]);
    const block = await vm.gather([NONE]).series.read(0, {
      frameOffset: 0,
      frameCount: 2,
      elementOffset: 0,
      elementCount: 1,
    });
    expect([...block.time]).toEqual([0, 1]);
    expect([...(await vm.gather([2, 0]).gather([1, 0]).at(1))]).toEqual([4, 6]);
    expect((await vm.gather([1]).at(0))[0]).toBe(2);
  });

  it('gathers a column and a sparse series alike', async () => {
    const model = sampleModel();
    const column = (await model.field({ classId: 'bus', kind: 'column', id: 'Vm' }))!;
    expect([...(await column.gather([2, 2, 0]).at(1e9))]).toEqual([0.98, 0.98, 1.02]);
    const sparse = Series.create({
      signals: ['x'],
      elementCount: 2,
      elements: Uint32Array.of(0, 2),
      time: Float64Array.of(0),
      values: Float64Array.of(7, 9),
    });
    const field = fieldOf(
      { classId: 'bus', kind: 'signal', id: 'x' },
      'X',
      '',
      sparse,
      0,
      3,
      always,
    );
    expect([...(await field.gather([2, 1, 0]).at(0))]).toEqual([9, NaN, 7]);
  });

  it('refuses an element outside the class', async () => {
    const { vm } = await recorded();
    for (const bad of [3, -1, 1.5, Number.NaN]) expect(() => vm.gather([bad])).toThrow(RangeError);
    expect(() => vm.gather(Uint32Array.of(NONE))).not.toThrow();
  });

  it('reads far-apart elements in bounded runs, never one span between them', async () => {
    const count = 200_000;
    const values = new Float32Array(count * 3);
    for (let i = 0; i < values.length; i++) values[i] = i;
    const source = Series.create({
      signals: ['x'],
      elementCount: count,
      time: Float64Array.of(0, 1, 2),
      values,
    });
    const read = vi.spyOn(source, 'read');
    const field = fieldOf(
      { classId: 'big', kind: 'signal', id: 'x' },
      'X',
      '',
      source,
      0,
      count,
      (time) => Math.min(2, Math.max(0, Math.floor(time))),
    );
    const picked = field.gather([count - 1, 0, 1, 60, count - 2]);
    const block = await picked.series.read(0, {
      frameOffset: 0,
      frameCount: 3,
      elementOffset: 0,
      elementCount: 5,
    });
    const at = (frame: number, element: number): number => frame * count + element;
    expect([...block.values]).toEqual(
      [0, 1, 2].flatMap((frame) => [
        at(frame, count - 1),
        at(frame, 0),
        at(frame, 1),
        at(frame, 60),
        at(frame, count - 2),
      ]),
    );
    expect(
      read.mock.calls.map(([, window]) => [window.elementOffset, window.elementCount]),
    ).toEqual([
      [0, 61],
      [count - 2, 2],
    ]);
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
