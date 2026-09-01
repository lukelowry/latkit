import { describe, expect, it } from 'vitest';

import { createModel, elementAt, itemOf, type Loader } from '../src/index.js';
import { sampleData, sampleLoader, sampleModel } from './fixture.js';

describe('createModel', () => {
  it('exposes the data it was given', () => {
    const model = sampleModel();
    expect(model.vendor).toBe('test');
    expect(model.classes.map((spec) => spec.id)).toEqual(['bus', 'branch', 'gen', 'area']);
    expect(model.meta).toEqual({ freqBase: 60, note: 'fixture', live: true, empty: null });
  });

  it('rejects inconsistent data at construction', () => {
    const loader = sampleLoader();
    const data = sampleData();
    const build = (patch: Partial<typeof data>) => () => createModel({ ...data, ...patch }, loader);

    expect(build({ id: '' })).toThrow(/model id/);
    expect(build({ owners: { vertex: 'nope' } })).toThrow(/owner 'nope'/);
    expect(build({ topology: { ...data.topology, edges: Uint32Array.of(0, 9) } })).toThrow(
      /out of range/,
    );
    expect(build({ classes: [...data.classes, data.classes[0]!] })).toThrow(/duplicate class/);
    expect(
      build({
        classes: data.classes.map((spec) =>
          spec.id === 'bus'
            ? { ...spec, anchor: { kind: 'vertex', index: Uint32Array.of(0, 1, 2) } }
            : spec,
        ),
      }),
    ).toThrow(/must not declare an anchor/);
    expect(
      build({
        classes: data.classes.map((spec) => (spec.id === 'bus' ? { ...spec, count: 2 } : spec)),
      }),
    ).toThrow(/one element per vertex/);
    expect(build({ meta: { bad: [1] as unknown as number } })).toThrow(/meta 'bad'/);
    expect(
      build({
        classes: data.classes.map((spec) =>
          spec.id === 'gen'
            ? {
                ...spec,
                signals: [{ id: 'P', label: 'P', unit: 1 as unknown as string, recorded: true }],
              }
            : spec,
        ),
      }),
    ).toThrow(/malformed/);
    expect(
      build({
        classes: data.classes.map((spec) =>
          spec.id === 'gen'
            ? { ...spec, anchor: { kind: 'vertex', index: Uint32Array.of(0, 7) } }
            : spec,
        ),
      }),
    ).toThrow(/beyond the topology/);
    expect(
      build({
        classes: data.classes.map((spec) =>
          spec.id === 'gen' ? { ...spec, signals: [...spec.signals, ...spec.signals] } : spec,
        ),
      }),
    ).toThrow(/repeats signal 'P'/);
  });

  it('loads a class once and shares it', async () => {
    const calls: string[] = [];
    const model = sampleModel(calls);
    const [a, b] = await Promise.all([model.load('bus'), model.load('bus')]);
    expect(a).toBe(b);
    expect(await model.load('bus')).toBe(a);
    expect(calls).toEqual(['bus']);
  });

  it('rejects an unknown class and malformed class data', async () => {
    await expect(sampleModel().load('nope')).rejects.toThrow(/unknown class/);
    const bad: Loader = {
      load: async () => ({ labels: ['x'], columns: [] }),
      bytes: async () => new Uint8Array(),
    };
    await expect(createModel(sampleData(), bad).load('bus')).rejects.toThrow(
      /one label per element/,
    );
    const badFlag: Loader = {
      load: async () => ({
        labels: ['a', 'b', 'c'],
        columns: [{ kind: 'flag', id: 'f', label: 'f', values: Uint8Array.of(0, 1, 2) }],
      }),
      bytes: async () => new Uint8Array(),
    };
    await expect(createModel(sampleData(), badFlag).load('bus')).rejects.toThrow(/only 0 or 1/);
  });

  it('lets one caller abort without cancelling the shared load', async () => {
    let release!: () => void;
    let aborted = false;
    const loader: Loader = {
      load: (id, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => (aborted = true));
          release = () => resolve(sampleLoader().load(id));
        }),
      bytes: async () => new Uint8Array(),
    };
    const model = createModel(sampleData(), loader);
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
    const loader: Loader = {
      load: (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      bytes: async () => new Uint8Array(),
    };
    const model = createModel(sampleData(), loader);
    const controller = new AbortController();
    const load = model.load('bus', controller.signal);
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });

  it('delegates bytes to the loader', async () => {
    const bytes = await sampleModel().bytes();
    expect(new TextDecoder().decode(bytes)).toBe('{"case":"sample"}');
  });
});

describe('elementAt and itemOf', () => {
  const model = sampleModel();

  it('resolves picks through the owners', () => {
    expect(elementAt(model, { kind: 'vertex', index: 1 })).toEqual({ classId: 'bus', index: 1 });
    expect(elementAt(model, { kind: 'edge', index: 0 })).toEqual({ classId: 'branch', index: 0 });
    expect(elementAt(model, { kind: 'vertex', index: 3 })).toBeNull();
  });

  it('resolves elements by identity for owners and through anchors otherwise', () => {
    expect(itemOf(model, { classId: 'bus', index: 2 })).toEqual({ kind: 'vertex', index: 2 });
    expect(itemOf(model, { classId: 'branch', index: 1 })).toEqual({ kind: 'edge', index: 1 });
    expect(itemOf(model, { classId: 'gen', index: 1 })).toEqual({ kind: 'vertex', index: 2 });
    const unplaced = createModel(
      {
        ...sampleData(),
        classes: sampleData().classes.map((spec) =>
          spec.id === 'gen'
            ? { ...spec, anchor: { kind: 'vertex', index: Uint32Array.of(0xffffffff, 2) } }
            : spec,
        ),
      },
      sampleLoader(),
    );
    expect(itemOf(unplaced, { classId: 'gen', index: 0 })).toBeNull();
    expect(itemOf(model, { classId: 'area', index: 0 })).toBeNull();
    expect(itemOf(model, { classId: 'gen', index: 2 })).toBeNull();
  });
});
