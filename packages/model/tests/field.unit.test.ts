import { describe, expect, it } from 'vitest';

import {
  type ClassData,
  type ClassSpec,
  extent,
  fieldKey,
  fieldsOf,
  type Series,
  validateDomain,
} from '../src/index.js';

const spec: ClassSpec = {
  id: 'bus',
  label: 'Bus',
  count: 2,
  signals: [
    { id: 'Vm', label: 'Voltage', unit: 'pu', recorded: true },
    { id: 'Va', label: 'Angle', unit: 'deg', recorded: false },
    { id: 'P', label: 'Power', unit: 'MW', recorded: true },
  ],
};

const data: ClassData = {
  labels: ['a', 'b'],
  columns: [
    { kind: 'number', id: 'kv', label: 'kV', unit: 'kV', values: Float64Array.of(1, 2) },
    { kind: 'text', id: 'name', label: 'Name', values: ['a', 'b'] },
    { kind: 'flag', id: 'gen', label: 'Generator', values: Uint8Array.of(1, 0) },
  ],
};

function results(signalCount: number): Series {
  return {
    time: Float64Array.of(0),
    elementCount: 2,
    signalCount,
    values: new Float32Array(signalCount * 2),
    ranges: new Float32Array(signalCount * 2),
  };
}

describe('fields', () => {
  it('lists number columns then recorded signals, with a blank unit for an unlabelled column', () => {
    expect(
      fieldsOf(spec, data).map((field) => [field.source, field.id, field.label, field.unit]),
    ).toEqual([
      ['column', 'kv', 'kV', 'kV'],
      ['signal', 'Vm', 'Voltage', 'pu'],
      ['signal', 'P', 'Power', 'MW'],
    ]);
    expect(fieldsOf(spec, null).map((field) => field.id)).toEqual(['Vm', 'P']);
  });

  it('offers signals only when the results carry every recorded one', () => {
    expect(fieldsOf(spec, data, results(2)).map((field) => field.id)).toEqual(['kv', 'Vm', 'P']);
    expect(fieldsOf(spec, data, results(1)).map((field) => field.id)).toEqual(['kv']);
  });

  it('keys a reference stably', () => {
    const ref = { classId: 'bus', source: 'signal', id: 'P' } as const;
    expect(fieldKey(ref)).toBe(fieldKey({ ...ref }));
    expect(fieldKey(ref)).not.toBe(fieldKey({ ...ref, source: 'column' }));
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
