import { describe, expect, it } from 'vitest';

import { type Model, validateTopology } from '../src/index.js';
import { Sample, sampleClass, sampleData, sampleModel, sampleValues } from './fixture.js';

describe('validateTopology', () => {
  const topology = () => sampleData().topology;

  it('accepts a consistent topology and every declared coordinate space', () => {
    expect(() => validateTopology(topology())).not.toThrow();
    expect(() => validateTopology({ ...topology(), coordinateSpace: 'cartesian' })).not.toThrow();
    expect(() =>
      validateTopology({
        vertexCount: 2,
        edges: Uint32Array.of(0, 1),
        polylineStart: Uint32Array.of(0, 0),
      }),
    ).not.toThrow();
  });

  it('names the first invalid field', () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['invalid vertex count', { vertexCount: -1 }],
      ['invalid vertex count', { vertexCount: 1.5 }],
      ['vertex coordinates must be Float32Array', { vertexCoords: [0, 0] }],
      ['invalid vertex coordinate length', { vertexCoords: Float32Array.of(0, 0) }],
      ['invalid vertex coordinates', { vertexCoords: Float32Array.of(0, 0, NaN, 1, 2, 2) }],
      ['invalid coordinate space', { coordinateSpace: 'polar' }],
      ['edges must be Uint32Array', { edges: [0, 1] }],
      ['invalid edge length', { edges: Uint32Array.of(0, 1, 2) }],
      ['edge endpoint out of range', { edges: Uint32Array.of(0, 9) }],
      ['polyline points must be Float32Array', { polylinePoints: [1, 2] }],
      ['invalid polyline point length', { polylinePoints: Float32Array.of(1) }],
      ['invalid polyline points', { polylinePoints: Float32Array.of(1, Infinity) }],
      ['polylineStart must be Uint32Array', { polylineStart: [0, 0, 1] }],
      ['invalid polylineStart length', { polylineStart: Uint32Array.of(0, 0) }],
      ['polylineStart must begin at zero', { polylineStart: Uint32Array.of(1, 1, 1) }],
      ['polylineStart terminal mismatch', { polylineStart: Uint32Array.of(0, 0, 0) }],
      [
        'polylineStart must be monotonic',
        { polylineStart: Uint32Array.of(0, 1, 0), polylinePoints: new Float32Array(0) },
      ],
    ];
    for (const [message, patch] of cases) {
      expect(() => validateTopology({ ...topology(), ...patch } as never), message).toThrow(
        message,
      );
    }
  });
});

describe('Model', () => {
  const build = (patch: Partial<Model.Description>) => () =>
    new Sample({ description: { ...sampleData(), ...patch } });
  const withClass = (id: string, patch: Record<string, unknown>) =>
    build({
      classes: sampleData().classes.map((spec) =>
        spec.id === id ? ({ ...spec, ...patch } as typeof spec) : spec,
      ),
    });

  it('exposes the description it was given, and each class by id', () => {
    const model = sampleModel();
    expect(model.format).toBe('test');
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'branch', 'gen', 'area']);
    expect(model.meta).toEqual({ freqBase: 60, note: 'fixture', live: true, empty: null });
    expect(model.class('gen')).toBe(model.classes[2]);
    expect(model.class('nope')).toBeUndefined();
  });

  it('rejects an inconsistent description at construction', () => {
    const data = sampleData();
    expect(build({ id: '' })).toThrow(/model id/);
    expect(build({ format: '' })).toThrow(/model format/);
    expect(build({ owners: { vertex: 'nope' } })).toThrow(/owner 'nope'/);
    expect(build({ topology: { ...data.topology, edges: Uint32Array.of(0, 9) } })).toThrow(
      /out of range/,
    );
    expect(build({ classes: [...data.classes, data.classes[0]!] })).toThrow(/duplicate class/);
    expect(build({ meta: { bad: [1] as unknown as number } })).toThrow(/meta 'bad'/);
    expect(
      withClass('bus', { anchor: { kind: 'vertex', index: Uint32Array.of(0, 1, 2) } }),
    ).toThrow(/must not declare an anchor/);
    expect(withClass('bus', { count: 2 })).toThrow(/one element per vertex/);
    expect(
      withClass('gen', {
        signals: [{ id: 'P', label: 'P', unit: 1 as unknown as string, recorded: true }],
      }),
    ).toThrow(/malformed/);
    expect(withClass('gen', { anchor: { kind: 'vertex', index: Uint32Array.of(0, 7) } })).toThrow(
      /beyond the topology/,
    );
    const gen = data.classes[2]!;
    expect(withClass('gen', { signals: [...gen.signals, ...gen.signals] })).toThrow(
      /repeats signal 'P'/,
    );
  });

  it('rejects columns a class declares badly', () => {
    expect(withClass('area', { columns: undefined })).toThrow(/columns must be an array/);
    expect(
      withClass('area', {
        columns: [
          { kind: 'number', id: 'x', label: 'X' },
          { kind: 'flag', id: 'x', label: 'X' },
        ],
      }),
    ).toThrow(/repeats column 'x'/);
    expect(withClass('area', { columns: [{ kind: 'date', id: 'x', label: 'X' }] })).toThrow(
      /column 'x' is malformed/,
    );
    expect(
      withClass('area', { columns: [{ kind: 'text', id: 'x', label: 'X', unit: 'kV' }] }),
    ).toThrow(/column 'x' is malformed/);
    expect(withClass('area', { columns: [{ kind: 'number', id: '', label: 'X' }] })).toThrow(
      /column id must be non-empty/,
    );
  });

  it('loads a class once, joining its values to the columns its spec declares', async () => {
    const calls: string[] = [];
    const model = sampleModel(calls);
    const [a, b] = await Promise.all([model.load('bus'), model.load('bus')]);
    expect(a).toBe(b);
    expect(await model.load('bus')).toBe(a);
    expect(calls).toEqual(['bus']);
    expect(a).toEqual(sampleClass('bus'));
    expect(a.columns[1]).toMatchObject({ kind: 'text', group: 'Location' });
  });

  it('rejects an unknown class and values that disagree with the spec', async () => {
    await expect(sampleModel().load('nope')).rejects.toThrow(/unknown class/);
    const loading = (values: unknown) =>
      new Sample({ values: () => Promise.resolve(values as Model.Values) }).load('bus');
    await expect(loading({ labels: ['x'], values: [] })).rejects.toThrow(/one label per element/);
    await expect(loading({ labels: ['a', 'b', 'c'], values: [] })).rejects.toThrow(
      /every declared column/,
    );
    const bus = sampleValues('bus');
    await expect(
      loading({ ...bus, values: [new Float32Array(3), ...bus.values.slice(1)] }),
    ).rejects.toThrow(/column 'Vm' has the wrong kind or length/);
    await expect(
      loading({ ...bus, values: [...bus.values.slice(0, 2), Uint8Array.of(0, 1, 2)] }),
    ).rejects.toThrow(/only 0 or 1/);
  });

  it('lets one caller abort without cancelling the shared load', async () => {
    let release!: () => void;
    let aborted = false;
    const model = new Sample({
      values: (id, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => (aborted = true));
          release = () => resolve(sampleValues(id));
        }),
    });
    const controller = new AbortController();
    const first = model.load('bus', controller.signal);
    const second = model.load('bus');
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(false);
    release();
    expect((await second).labels).toEqual(['North', 'Middle', 'South']);
  });

  it('aborts the underlying load once every caller has abandoned it', async () => {
    let aborted = false;
    const model = new Sample({
      values: (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const controller = new AbortController();
    const load = model.load('bus', controller.signal);
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });

  it('gives the bytes its format gives', async () => {
    const bytes = await sampleModel().bytes();
    expect(new TextDecoder().decode(bytes)).toBe('{"case":"sample"}');
  });
});

describe('elementAt and itemOf', () => {
  const model = sampleModel();

  it('resolves picks through the owners', () => {
    expect(model.elementAt({ kind: 'vertex', index: 1 })).toEqual({ classId: 'bus', index: 1 });
    expect(model.elementAt({ kind: 'edge', index: 0 })).toEqual({ classId: 'branch', index: 0 });
    expect(model.elementAt({ kind: 'vertex', index: 3 })).toBeNull();
    expect(model.elementAt({ kind: 'vertex', index: 0.5 })).toBeNull();
  });

  it('resolves elements by identity for owners and through anchors otherwise', () => {
    expect(model.itemOf({ classId: 'bus', index: 2 })).toEqual({ kind: 'vertex', index: 2 });
    expect(model.itemOf({ classId: 'branch', index: 1 })).toEqual({ kind: 'edge', index: 1 });
    expect(model.itemOf({ classId: 'gen', index: 1 })).toEqual({ kind: 'vertex', index: 2 });
    const unplaced = new Sample({
      description: {
        ...sampleData(),
        classes: sampleData().classes.map((spec) =>
          spec.id === 'gen'
            ? { ...spec, anchor: { kind: 'vertex', index: Uint32Array.of(0xffffffff, 2) } }
            : spec,
        ),
      },
    });
    expect(unplaced.itemOf({ classId: 'gen', index: 0 })).toBeNull();
    expect(model.itemOf({ classId: 'area', index: 0 })).toBeNull();
    expect(model.itemOf({ classId: 'gen', index: 2 })).toBeNull();
    expect(model.itemOf({ classId: 'nope', index: 0 })).toBeNull();
  });
});

describe('fields', () => {
  it('lists what field resolves: number columns, then the signals a recording holds', async () => {
    const model = sampleModel();
    expect(model.fields('bus')).toEqual([
      { ref: { classId: 'bus', kind: 'column', id: 'Vm' }, label: 'Voltage', unit: 'pu' },
      { ref: { classId: 'bus', kind: 'signal', id: 'Vm' }, label: 'Voltage', unit: 'pu' },
    ]);
    expect(model.fields('gen')).toEqual([
      { ref: { classId: 'gen', kind: 'signal', id: 'P' }, label: 'Power', unit: 'MW' },
    ]);
    expect(model.fields('branch')).toEqual([]);
    expect(model.fields('nowhere')).toEqual([]);
    expect(model.fields('bus')).toBe(model.fields('bus'));
    expect(Object.isFrozen(model.fields('bus')[0]!.ref)).toBe(true);
    expect(await model.field(model.fields('bus')[0]!.ref)).not.toBeNull();
  });
});
