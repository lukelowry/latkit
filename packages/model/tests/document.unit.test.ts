import { describe, expect, it, vi } from 'vitest';

import { Document, type Model, Refusal } from '../src/index.js';
import { Player, Sample, sampleData, sampleModel } from './fixture.js';

/**
 * Two blocks, a generator and its governor, joined by one wired net; the generator's first port is
 * also on a tagged net for bus 0.
 */
function schematic(): Document.Schematic {
  return {
    netlist: {
      blockCount: 2,
      blockKey: ['gen/G1', 'gen/G2'],
      portStart: Uint32Array.of(0, 2, 3),
      portFlow: Uint8Array.of(2, 1, 0),
      portLabel: ['bus', 'speed', 'speed'],
      netStart: Uint32Array.of(0, 1, 3),
      netPorts: Uint32Array.of(0, 1, 2),
      netStyle: Uint8Array.of(1, 0),
    },
    blocks: [
      { classId: 'gen', index: 0 },
      { classId: 'gen', index: 1 },
    ],
    nets: [{ classId: 'bus', index: 0 }, null],
    sources: [null, { field: { classId: 'gen', kind: 'signal', id: 'P' }, index: 0 }],
    status: new Float32Array(3),
    positions: new Float32Array(4).fill(NaN),
    problems: [],
  };
}

/** A document whose case is a counter of values changes, and whose model follows it. */
class Counter extends Document {
  revision = 0;
  readonly opened: number[] = [];
  #schematic = schematic();

  constructor(model: Model) {
    super(model);
  }

  get schematic(): Document.Schematic {
    return this.#schematic;
  }

  get palette(): readonly Document.BlockClass[] {
    return [{ classId: 'gen', label: 'Generator', group: 'Machines', ports: [] }];
  }

  keyOf(element: Model.Element): string | null {
    return `${element.classId}/${element.index}`;
  }

  find(key: string): Model.Element | null {
    const [classId, index] = key.split('/');
    return classId && index ? { classId, index: Number(index) } : null;
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.of(this.revision));
  }

  protected change(operations: readonly Document.Operation[]): Document.Change | null {
    const [operation] = operations;
    if (operation?.kind === 'remove') throw new Refusal('a generator stays', operation.elements[0]);
    if (operation?.kind === 'place') {
      this.#schematic = {
        ...this.#schematic,
        positions: operation.positions ?? new Float32Array(4),
      };
      return { label: 'Place', scope: 'layout', created: [] };
    }
    if (operation?.kind !== 'set') return null;
    this.revision++;
    return { label: `Set ${operation.column}`, scope: 'values', created: [] };
  }

  protected revert(change: Document.Change): Document.Change {
    this.revision += change.label.startsWith('Revert') ? 1 : -1;
    return {
      ...change,
      label: change.label.startsWith('Revert') ? change.label.slice(7) : `Revert ${change.label}`,
    };
  }

  protected open(): Promise<Model> {
    this.opened.push(this.revision);
    return Promise.resolve(
      new Sample({ description: { ...sampleData(), id: `sample-${this.revision}` } }),
    );
  }
}

const set: Document.Operation = {
  kind: 'set',
  element: { classId: 'bus', index: 0 },
  column: 'Vm',
  value: 1,
};

describe('document', () => {
  it('keeps one history of steps it makes, takes back, and makes again', () => {
    const document = new Counter(sampleModel());
    const heard = vi.fn<(label: string) => void>();
    document.on('change', (change) => heard(change.label));
    expect(document.apply(set)).toMatchObject({ label: 'Set Vm', scope: 'values' });
    expect(
      document.apply({ kind: 'connect', from: document.portAt(1), to: document.portAt(2) }),
    ).toBeNull();
    expect(document.history.undo.map((change) => change.label)).toEqual(['Set Vm']);
    expect(document.undo()?.label).toBe('Revert Set Vm');
    expect(document.revision).toBe(0);
    expect(document.history).toEqual({
      undo: [],
      redo: [expect.objectContaining({ label: 'Revert Set Vm' })],
    });
    expect(document.redo()?.label).toBe('Set Vm');
    expect(document.revision).toBe(1);
    expect(document.undo()?.label).toBe('Revert Set Vm');
    expect(document.undo()).toBeNull();
    expect(document.redo()?.label).toBe('Set Vm');
    expect(document.redo()).toBeNull();
    expect(heard.mock.calls.map(([label]) => label)).toEqual([
      'Set Vm',
      'Revert Set Vm',
      'Set Vm',
      'Revert Set Vm',
      'Set Vm',
    ]);
  });

  it('keeps the last 200 steps, forgetting the oldest', () => {
    const document = new Counter(sampleModel());
    for (let step = 0; step < 201; step++) document.apply(set);
    expect(document.history.undo).toHaveLength(200);
    while (document.undo());
    expect(document.revision).toBe(1);
    expect(document.history.redo).toHaveLength(200);
  });

  it('refuses an edit without changing anything, saying what it is about', () => {
    const document = new Counter(sampleModel());
    const heard = vi.fn();
    document.on('change', heard);
    const removing = () =>
      document.apply({ kind: 'remove', elements: [{ classId: 'gen', index: 1 }] });
    expect(removing).toThrow(Refusal);
    try {
      removing();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'Refusal',
        message: 'a generator stays',
        at: { classId: 'gen', index: 1 },
      });
    }
    expect(document.history.undo).toEqual([]);
    expect(heard).not.toHaveBeenCalled();
  });

  it('opens one model for the changes before it is asked for, keeping the engine', async () => {
    const model = sampleModel();
    const engine = new Player([]);
    model.engine = engine;
    const document = new Counter(model);
    expect(await document.model()).toBe(model);
    document.apply({
      kind: 'place',
      elements: [{ classId: 'gen', index: 0 }],
      positions: Float32Array.of(1, 2),
    });
    expect(await document.model()).toBe(model);
    document.apply(set);
    document.apply({ ...set, column: 'Va' });
    expect(document.opened).toEqual([]);
    const edited = await document.model();
    expect(edited).not.toBe(model);
    expect(edited.id).toBe('sample-2');
    expect(edited.engine).toBe(engine);
    expect(await document.model()).toBe(edited);
    expect(document.opened).toEqual([2]);
    document.undo();
    expect((await document.model()).id).toBe('sample-1');
    expect(document.opened).toEqual([2, 1]);
    await expect(document.model(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('abandons an open a change supersedes, and opens the case as it stands next', async () => {
    const document = new Counter(sampleModel());
    document.apply(set);
    const superseded = document.model();
    document.apply({ ...set, column: 'Va' });
    await expect(superseded).rejects.toMatchObject({ name: 'AbortError' });
    expect((await document.model()).id).toBe('sample-2');
    expect(document.opened).toEqual([1, 2]);
  });

  it('maps parts to elements and back, a port to its block, and a port by name', () => {
    const document = new Counter(sampleModel());
    expect(document.elementAt({ kind: 'block', index: 1 })).toEqual({ classId: 'gen', index: 1 });
    expect(document.elementAt({ kind: 'net', index: 0 })).toEqual({ classId: 'bus', index: 0 });
    expect(document.elementAt({ kind: 'net', index: 1 })).toBeNull();
    expect(document.elementAt({ kind: 'port', index: 2 })).toEqual({ classId: 'gen', index: 1 });
    expect(document.elementAt({ kind: 'port', index: 3 })).toBeNull();
    expect(document.elementAt({ kind: 'group', index: 0 })).toBeNull();
    expect(document.partOf({ classId: 'gen', index: 0 })).toEqual({ kind: 'block', index: 0 });
    expect(document.partOf({ classId: 'bus', index: 0 })).toEqual({ kind: 'net', index: 0 });
    expect(document.partOf({ classId: 'bus', index: 1 })).toBeNull();
    expect(document.portAt(1)).toEqual({ element: { classId: 'gen', index: 0 }, port: 'speed' });
    expect(document.portOf({ element: { classId: 'gen', index: 1 }, port: 'speed' })).toBe(2);
    expect(document.portOf({ element: { classId: 'gen', index: 1 }, port: 'bus' })).toBeNull();
    expect(document.portOf({ element: { classId: 'bus', index: 0 }, port: 'bus' })).toBeNull();
  });

  it('gives its identities, bytes, and palette as its format says', async () => {
    const document = new Counter(sampleModel());
    expect(document.keyOf({ classId: 'gen', index: 1 })).toBe('gen/1');
    expect(document.find('gen/1')).toEqual({ classId: 'gen', index: 1 });
    expect([...(await document.bytes())]).toEqual([0]);
    expect(document.palette.map((block) => block.classId)).toEqual(['gen']);
  });
});
