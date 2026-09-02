import { describe, expect, it } from 'vitest';

import { type ClassData, type ClassSpec, fieldKey, fieldsOf, type Series } from '../src/index.js';

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
