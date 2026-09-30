import { describe, expect, it, vi } from 'vitest';

import { Document, DocumentConflict, Engine, Model, Refusal } from '../src/index.js';
import { ended, Sample, sampleData } from './fixture.js';

/** Two blocks and nothing wired: all the diagram a tally needs. */
function schematic(): Document.Schematic {
  return {
    netlist: {
      blockCount: 2,
      portStart: Uint32Array.of(0, 0, 0),
      portFlow: new Uint8Array(),
      netStart: Uint32Array.of(0),
      netPorts: new Uint32Array(),
    },
    blocks: [
      { classId: 'bus', index: 0 },
      { classId: 'bus', index: 1 },
    ],
    nets: [],
    sources: [],
    status: new Float32Array(),
    positions: new Float32Array(4).fill(NaN),
    problems: [],
  };
}

/** A case that is one number, its native bytes one byte; `set` makes it that number. */
class Tally extends Document {
  value: number;
  readonly models: Model[] = [];
  /** Holds every model open until it resolves. */
  opening: Promise<void> | null = null;
  #schematic = schematic();

  constructor(value = 0) {
    super();
    this.value = value;
  }
  get schematic(): Document.Schematic {
    return this.#schematic;
  }
  get palette(): readonly Document.BlockClass[] {
    return [];
  }
  keyOf(element: Model.Element): string | null {
    return `${element.classId}/${element.index}`;
  }
  find(key: string): Model.Element | null {
    const [classId, index] = key.split('/');
    return classId && index ? { classId, index: Number(index) } : null;
  }
  inspect(element: Model.Element): Document.Inspection | null {
    if (this.partOf(element) === null) return null;
    return { element, key: this.keyOf(element), values: { v: this.value }, ports: [], members: [] };
  }
  bytes(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.of(this.value));
  }
  protected change(operations: readonly Document.Operation[]): Document.Change | null {
    const [operation] = operations;
    if (operation?.kind === 'remove') throw new Refusal('Keep this bus', operation.elements[0]);
    if (operation?.kind === 'place') {
      this.#schematic = { ...this.#schematic, positions: operation.positions! };
      return { label: 'Place', scope: 'layout', created: [] };
    }
    if (operation?.kind !== 'set' || operation.value === this.value) return null;
    const before = this.value;
    this.value = operation.value as number;
    return { label: 'Set', scope: 'values', created: [], before } as Document.Change;
  }
  protected revert(change: Document.Change): Document.Change {
    const before = this.value;
    this.value = (change as Document.Change & { before: number }).before;
    return { ...change, before } as Document.Change;
  }
  protected async open(): Promise<Model> {
    const value = this.value;
    await this.opening;
    const model = new Sample({ description: { ...sampleData(), id: `tally-${value}` } });
    this.models.push(model);
    return model;
  }
}

const set = (value: number): Document.Operation => ({
  kind: 'set',
  element: { classId: 'bus', index: 0 },
  column: 'v',
  value,
});

/** The tally format, noting every document it opens or creates; `creates: false` drops `create`. */
function tallies({ creates = true } = {}): Document.Format & { readonly opened: Tally[] } {
  const opened: Tally[] = [];
  const format = {
    id: 'tally',
    label: 'Tally',
    extensions: ['.tally'],
    opened,
    open(bytes: Uint8Array): Promise<Document> {
      const tally = new Tally(bytes[0] ?? 0);
      opened.push(tally);
      return Promise.resolve(tally);
    },
  };
  return creates
    ? {
        ...format,
        create(title: string): Promise<Document> {
          const tally = new Tally(title.length);
          opened.push(tally);
          return Promise.resolve(tally);
        },
      }
    : format;
}

/** Cases kept in memory, each tagged by the write that made it; `reads` names each read. */
function memory(initial: Record<string, readonly number[]> = {}) {
  const kept = new Map<string, { readonly bytes: Uint8Array; readonly tag: string }>();
  let writes = 0;
  for (const [name, bytes] of Object.entries(initial))
    kept.set(name, { bytes: Uint8Array.from(bytes), tag: `t${++writes}` });
  const reads: string[] = [];
  const store: Engine.Cases = {
    list: () => Promise.resolve([...kept.keys()]),
    read(name) {
      reads.push(name);
      const entry = kept.get(name);
      if (!entry) return Promise.reject(new Error(`No case ${name}.`));
      return Promise.resolve({ bytes: entry.bytes.slice(), tag: entry.tag });
    },
    write(name, bytes, tag) {
      if ((kept.get(name)?.tag ?? null) !== tag)
        return Promise.reject(new Error(`The case ${name} changed.`));
      const next = `t${++writes}`;
      kept.set(name, { bytes: bytes.slice(), tag: next });
      return Promise.resolve(next);
    },
  };
  return { store, kept, reads, bytes: (name: string) => [...(kept.get(name)?.bytes ?? [])] };
}

/** An engine that keeps cases and records by running `execute`, forever unless it is stopped. */
class Keeper extends Engine {
  constructor(
    options: {
      readonly formats?: readonly Document.Format[];
      readonly cases?: Engine.Cases;
      readonly idleBytes?: number;
    } = {},
  ) {
    super({ concurrency: Infinity, ...options });
  }
  protected parse(input: unknown): unknown {
    return input;
  }
  protected execute(_model: Model, _input: unknown, recorder: Engine.Recorder): Promise<void> {
    return new Promise((_resolve, reject) =>
      recorder.signal.addEventListener('abort', () => reject(new Error('stopped'))),
    );
  }
}

function keeper(initial: Record<string, readonly number[]> = {}, idleBytes?: number) {
  const format = tallies();
  const kept = memory(initial);
  const engine = new Keeper({
    formats: [format],
    cases: kept.store,
    ...(idleBytes === undefined ? {} : { idleBytes }),
  });
  return { engine, format, ...kept };
}

describe('engine cases', () => {
  it('lists the cases in a format it opens by name, and the version each open one saved', async () => {
    const { engine } = keeper({ 'b.tally': [1], 'a.tally': [2], 'notes.txt': [0] });
    expect(engine.formats).toEqual([
      { id: 'tally', label: 'Tally', extensions: ['.tally'], creates: true },
    ]);
    expect(await engine.cases()).toEqual([
      { name: 'a.tally', format: 'tally', saved: null },
      { name: 'b.tally', format: 'tally', saved: null },
    ]);
    const session = await engine.open('a.tally');
    expect((await engine.cases())[0]).toEqual({
      name: 'a.tally',
      format: 'tally',
      saved: session.view.version,
    });
  });

  it('opens one document per case, which every session on it shares', async () => {
    const { engine, format } = keeper({ 'a.tally': [2] });
    const [first, second] = await Promise.all([engine.open('a.tally'), engine.open('a.tally')]);
    const third = await engine.open('a.tally');
    expect(format.opened).toHaveLength(1);
    const heard = vi.fn();
    third.on('change', heard);
    await first.apply(set(5));
    expect(second.view.version).toEqual(first.view.version);
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ label: 'Set' }));
    expect([...(await third.bytes())]).toEqual([5]);
    await second.undo();
    expect([...(await first.bytes())]).toEqual([2]);
  });

  it('keeps clean cases no one uses open while they fit its budget, the least recently opened going first', async () => {
    const { engine, reads } = keeper({ 'a.tally': [1], 'b.tally': [2] }, 1);
    (await engine.open('a.tally')).close();
    (await engine.open('b.tally')).close();
    (await engine.open('b.tally')).close();
    expect(reads).toEqual(['a.tally', 'b.tally']);
    (await engine.open('a.tally')).close();
    expect(reads).toEqual(['a.tally', 'b.tally', 'a.tally']);
    (await engine.open('b.tally')).close();
    expect(reads).toEqual(['a.tally', 'b.tally', 'a.tally', 'b.tally']);
  });

  it('keeps a case with unsaved edits open whatever the budget, until they are saved', async () => {
    const { engine, format, reads } = keeper({ 'a.tally': [1] }, 0);
    const session = await engine.open('a.tally');
    await session.apply(set(4));
    const version = session.view.version;
    session.close();
    const again = await engine.open('a.tally');
    expect(format.opened).toHaveLength(1);
    expect(again.view.version).toEqual(version);
    expect((await engine.cases())[0]!.saved).not.toEqual(version);
    await engine.save('a.tally', version);
    again.close();
    (await engine.open('a.tally')).close();
    expect(reads).toEqual(['a.tally', 'a.tally']);
  });

  it('saves the version a session names, refusing one gone by or a case changed elsewhere', async () => {
    const { engine, kept, bytes } = keeper({ 'a.tally': [1], 'b.tally': [2] });
    await expect(engine.save('b.tally', { epoch: 'x', revision: 0 })).rejects.toThrow('not open');
    const session = await engine.open('a.tally');
    await session.apply(set(7));
    const seven = session.view.version;
    expect(await engine.save('a.tally', seven)).toEqual({
      name: 'a.tally',
      format: 'tally',
      saved: seven,
    });
    expect(bytes('a.tally')).toEqual([7]);
    await session.apply(set(8));
    await expect(engine.save('a.tally', seven)).rejects.toBeInstanceOf(DocumentConflict);
    expect(bytes('a.tally')).toEqual([7]);
    kept.set('a.tally', { bytes: Uint8Array.of(0), tag: 'elsewhere' });
    await expect(engine.save('a.tally', session.view.version)).rejects.toThrow('changed');
    expect(bytes('a.tally')).toEqual([0]);
    expect((await engine.cases())[0]!.saved).toEqual(seven);
  });

  it('creates a case, titled or from a file, keeping it at once', async () => {
    const { engine, bytes } = keeper();
    const titled = await engine.create('new.tally', { title: 'abc' });
    expect(bytes('new.tally')).toEqual([3]);
    expect(titled.view.version.revision).toBe(0);
    await expect(engine.create('new.tally', { title: 'again' })).rejects.toThrow('exists');
    const copied = await engine.create('copy.tally', {
      file: new File([Uint8Array.of(9)], 'copy.tally'),
    });
    expect([...(await copied.bytes())]).toEqual([9]);
    expect(bytes('copy.tally')).toEqual([9]);
    expect((await engine.cases()).map(({ name, saved }) => [name, saved])).toEqual([
      ['copy.tally', copied.view.version],
      ['new.tally', titled.view.version],
    ]);
    await expect(engine.create('new.txt', { title: 'x' })).rejects.toThrow('No format opens');
    const reader = new Keeper({ formats: [tallies({ creates: false })], cases: memory().store });
    expect(reader.formats[0]!.creates).toBe(false);
    await expect(reader.create('a.tally', { title: 'a' })).rejects.toThrow('cannot create');
  });

  it('keeps no cases without a store, and refuses formats that claim one name twice', async () => {
    const plain = new Keeper();
    expect(plain.formats).toEqual([]);
    expect(await plain.cases()).toEqual([]);
    await expect(plain.open('a.tally')).rejects.toThrow('keeps no cases');
    const formatOnly = new Keeper({ formats: [tallies()] });
    expect(await formatOnly.cases()).toEqual([]);
    await expect(formatOnly.open('a.tally')).rejects.toThrow('keeps no cases');
    expect(() => new Keeper({ formats: [tallies(), tallies()] })).toThrow('unique');
    expect(() => new Keeper({ formats: [tallies(), { ...tallies(), id: 'other' }] })).toThrow(
      'one format',
    );
    expect(() => new Keeper({ formats: [{ ...tallies(), extensions: [] }] })).toThrow(
      'no extension',
    );
  });

  it('forgets a case that does not open, so the next open tries again', async () => {
    const { engine, format, reads } = keeper({ 'bad.tally': [1] });
    const open = vi.spyOn(format, 'open').mockRejectedValueOnce(new Error('Not a tally.'));
    await expect(engine.open('bad.tally')).rejects.toThrow('Not a tally.');
    await expect(engine.open('missing.tally')).rejects.toThrow('No case');
    expect(await engine.open('bad.tally')).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
    expect(reads).toEqual(['bad.tally', 'missing.tally', 'bad.tally']);
  });

  it('closes every session and stops every recording as it closes, and refuses work after', async () => {
    const { engine } = keeper({ 'a.tally': [1] });
    const session = await engine.open('a.tally');
    const model = await session.model();
    const recording = engine.record(model, null);
    await vi.waitFor(() => expect(recording.state.status).toBe('recording'));
    await engine.close();
    await ended(recording);
    expect(recording.state.status).toBe('stopped');
    await expect(session.bytes()).rejects.toThrow('closed');
    await expect(engine.open('a.tally')).rejects.toThrow('closed');
    await expect(engine.cases()).rejects.toThrow('closed');
    expect(() => engine.record(model, null)).toThrow('closed');
    expect(engine.close()).toBe(engine.close());
  });
});

describe('document session', () => {
  async function opened(initial = 0) {
    const { engine, format } = keeper({ 'a.tally': [initial] });
    const session = await engine.open('a.tally');
    return { engine, session, document: format.opened[0]! };
  }

  it('sees the document as it stands, one view per version', async () => {
    const { session, document } = await opened();
    const view = session.view;
    expect(session.view).toBe(view);
    expect(view.schematic).toBe(document.schematic);
    await session.apply(set(3));
    expect(session.view).not.toBe(view);
    expect(session.view.version.revision).toBe(1);
    expect(session.view.history.undo).toEqual([expect.objectContaining({ label: 'Set' })]);
    expect(session.partOf({ classId: 'bus', index: 1 })).toEqual({ kind: 'block', index: 1 });
  });

  it('applies an edit against the revision it names, refusing one gone by and saying why', async () => {
    const { session, document } = await opened();
    const base = session.view.version;
    await session.apply(set(1));
    await expect(session.apply(base, set(2))).rejects.toMatchObject({
      name: 'DocumentConflict',
      expected: base,
      actual: session.view.version,
    });
    await expect(
      session.apply({ kind: 'remove', elements: [{ classId: 'bus', index: 1 }] }),
    ).rejects.toMatchObject({ name: 'Refusal', at: { classId: 'bus', index: 1 } });
    expect(await session.apply(set(1))).toBeNull();
    expect(document.value).toBe(1);
    expect(session.view.version.revision).toBe(1);
  });

  it('takes what an edit or a read names as it is called, not as it is later', async () => {
    const { session, document } = await opened();
    const positions = Float32Array.of(2, 3, 4, 5);
    const placing = session.apply({
      kind: 'place',
      elements: [
        { classId: 'bus', index: 0 },
        { classId: 'bus', index: 1 },
      ],
      positions,
    });
    positions.fill(99);
    await placing;
    expect([...document.schematic.positions]).toEqual([2, 3, 4, 5]);
    const target = { classId: 'bus', index: 0 };
    const reading = session.inspect(target);
    target.index = 1;
    expect((await reading).inspection?.element.index).toBe(0);
  });

  it('runs every call in turn, a read after an edit asked before it refusing its stale base', async () => {
    const { engine, session, document } = await opened();
    const other = await engine.open('a.tally');
    let release!: () => void;
    document.opening = new Promise((resolve) => (release = resolve));
    const capture = session.model();
    const editing = other.apply(set(6));
    const stale = session.bytes();
    await Promise.resolve();
    expect(document.value).toBe(0);
    release();
    const model = await capture;
    expect(model.id).toBe('tally-0');
    expect(await editing).toMatchObject({ label: 'Set' });
    await expect(stale).rejects.toBeInstanceOf(DocumentConflict);
    expect([...(await session.bytes())]).toEqual([6]);
  });

  it('lets an aborted caller go at once, skipping its turn', async () => {
    const { session, document } = await opened();
    let release!: () => void;
    document.opening = new Promise((resolve) => (release = resolve));
    const capture = session.model();
    const inspect = vi.spyOn(document, 'inspect');
    const controller = new AbortController();
    const cancelled = session.inspect('bus/0', controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(session.bytes(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await capture;
    expect(inspect).not.toHaveBeenCalled();
    expect((await session.inspect('bus/0')).inspection?.values).toEqual({ v: 0 });
  });

  it('refuses a call while 256 wait on its document', async () => {
    const { session, document } = await opened();
    let release!: () => void;
    document.opening = new Promise((resolve) => (release = resolve));
    const waiting = [session.model(), ...Array.from({ length: 255 }, () => session.bytes())];
    await expect(session.inspect('bus/0')).rejects.toThrow('busy');
    release();
    await Promise.all(waiting);
    expect((await session.inspect('bus/0')).inspection).not.toBeNull();
  });

  it('tells every session on a case what its engine keeps, whichever saved it', async () => {
    const { engine } = await opened(1);
    const [first, second] = await Promise.all([engine.open('a.tally'), engine.open('a.tally')]);
    expect(first.view.saved).toEqual(first.view.version);
    const heard = vi.fn();
    second.on('saved', heard);
    await first.apply(set(4));
    expect(second.view.saved).not.toEqual(second.view.version);
    const view = second.view;
    await engine.save('a.tally', first.view.version);
    expect(heard).toHaveBeenCalledWith(first.view.version);
    expect(second.view.saved).toEqual(second.view.version);
    expect(second.view).not.toBe(view);
    expect(second.view.history).toBe(view.history);
  });

  it('closes once, refusing its calls and hearing nothing after', async () => {
    const { engine, session } = await opened();
    const other = await engine.open('a.tally');
    const heard = vi.fn();
    session.on('change', heard);
    session.close();
    session.close();
    await other.apply(set(2));
    expect(heard).not.toHaveBeenCalled();
    await expect(session.apply(set(3))).rejects.toThrow('closed');
    await expect(session.model()).rejects.toThrow('closed');
    expect([...(await other.bytes())]).toEqual([2]);
  });
});

describe('model close', () => {
  it('closes the source a model opened from, and nothing for one made here', async () => {
    const close = vi.fn();
    const source = { ...new Sample().source(), close };
    const opened = await Model.from(source);
    opened.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(opened.source()).not.toHaveProperty('close');
    expect(() => new Sample().close()).not.toThrow();
  });
});
