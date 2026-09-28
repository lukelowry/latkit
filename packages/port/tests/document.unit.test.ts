import { afterEach, describe, expect, it, vi } from 'vitest';
import { Document, DocumentConflict, Refusal, type Model } from '@latkit/model';

import {
  connect,
  connectDocument,
  connectEngine,
  connectModel,
  loopback,
  messagePort,
  protocol,
  serveDocument,
  serveEngine,
  serveModel,
  type Port,
} from '../src/index.js';
import { DOCUMENT, type Reply, type Request, type Update } from '../src/document-protocol.js';
import { hosted } from '../src/model.js';
import { ended, Fixture, Scripted, settle } from './fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

interface State {
  readonly value: number;
  readonly count: number;
  readonly positions: Float32Array;
}
interface Step extends Document.Change {
  readonly before: State;
  readonly privateInverse: () => void;
}

class Editable extends Document {
  state: State = { value: 0, count: 2, positions: new Float32Array(4).fill(NaN) };
  applied = 0;
  readonly models: Model[] = [];
  opening: Promise<void> | null = null;
  #schematic: Document.Schematic;

  constructor() {
    super(new Fixture('0'));
    this.#schematic = this.describe();
  }
  get schematic(): Document.Schematic {
    return this.#schematic;
  }
  get palette(): readonly Document.BlockClass[] {
    return [{ classId: 'bus', label: 'Bus', group: 'Network', ports: [] }];
  }
  keyOf(element: Model.Element): string | null {
    const { classId, index } = element;
    const count = classId === 'bus' ? this.state.count : classId === 'signal' ? 1 : 0;
    return Number.isInteger(index) && index >= 0 && index < count ? `${classId}/${index}` : null;
  }
  find(key: string): Model.Element | null {
    const [classId, at] = key.split('/');
    const element = { classId, index: Number(at) };
    return this.keyOf(element) === key ? element : null;
  }
  inspect(element: Model.Element): Document.Inspection | null {
    const key = this.keyOf(element);
    if (key === null) return null;
    const net = { element: { classId: 'signal', index: 0 }, key: 'signal/0' };
    return {
      element,
      key,
      values:
        element.classId === 'bus'
          ? { kv: this.state.value, enabled: true, label: 'Bus', limit: null }
          : {},
      ports:
        element.classId === 'bus'
          ? [
              { name: 'voltage', net },
              { name: 'unused', net: null },
            ]
          : [],
      members:
        element.classId === 'signal'
          ? Array.from({ length: this.state.count }, (_, index) => ({
              owner: { element: { classId: 'bus', index }, key: `bus/${index}` },
              port: 'voltage',
            }))
          : [],
    };
  }
  bytes(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.of(this.state.value));
  }

  describe(): Document.Schematic {
    return {
      netlist: {
        blockCount: this.state.count,
        portStart: new Uint32Array(this.state.count + 1),
        portFlow: new Uint8Array(),
        netStart: Uint32Array.of(0),
        netPorts: new Uint32Array(),
      },
      blocks: Array.from({ length: this.state.count }, (_, index) => ({ classId: 'bus', index })),
      nets: [],
      sources: [],
      status: new Float32Array(),
      positions: this.state.positions,
      problems: [],
    };
  }
  protected change(operations: readonly Document.Operation[]): Step | null {
    const before = this.state;
    let next = before;
    let scope: Document.Change['scope'] = 'values';
    const created: Model.Element[] = [];
    for (const operation of operations) {
      if (operation.kind === 'remove') throw new Refusal('Keep this bus', operation.elements[0]);
      if (operation.kind === 'record') throw new Refusal('Nothing records here', operation.signal);
      if (operation.kind === 'set') {
        if (typeof operation.value !== 'number')
          throw new Refusal('A number is required', operation.element);
        next = { ...next, value: operation.value };
      } else if (operation.kind === 'insert') {
        created.push({ classId: 'bus', index: next.count });
        next = {
          ...next,
          count: next.count + 1,
          positions: new Float32Array((next.count + 1) * 2).fill(NaN),
        };
        scope = 'structure';
      } else if (operation.kind === 'place') {
        const positions = next.positions.slice();
        operation.elements.forEach((element, i) => {
          positions[element.index * 2] = operation.positions?.[i * 2] ?? NaN;
          positions[element.index * 2 + 1] = operation.positions?.[i * 2 + 1] ?? NaN;
        });
        next = { ...next, positions };
        scope = 'layout';
      }
    }
    if (next === before || (scope === 'values' && next.value === before.value)) return null;
    this.applied++;
    this.state = next;
    this.#schematic =
      scope === 'structure' ? this.describe() : { ...this.#schematic, positions: next.positions };
    return { label: 'Edit', scope, created, before, privateInverse() {} };
  }
  protected revert(change: Document.Change): Step {
    const before = this.state;
    this.state = (change as Step).before;
    this.#schematic = this.describe();
    return { label: 'Undo edit', scope: change.scope, created: [], before, privateInverse() {} };
  }
  protected async open(): Promise<Model> {
    const value = this.state.value;
    await this.opening;
    const model = new Fixture(String(value));
    this.models.push(model);
    return model;
  }
}
const set = (value: number): Document.Operation => ({
  kind: 'set',
  element: { classId: 'bus', index: 0 },
  column: 'kv',
  value,
});
async function setup(document = new Editable()) {
  const [server, client] = loopback();
  const stop = serveDocument(server, document);
  cleanups.push(stop);
  const session = await connectDocument(client);
  cleanups.push(() => session.close());
  return { document, server, client, session, stop };
}
async function rawSetup(document = new Editable()) {
  const [server, client] = loopback();
  cleanups.push(serveDocument(server, document));
  const calls = connect(client, DOCUMENT);
  cleanups.push(() => calls.close());
  const opened = await calls.call({ op: 'open' });
  if (opened.kind !== 'opened') throw new Error('not opened');
  return { document, server, client, calls, opened };
}

describe('document service', () => {
  it('serves a model without opening an unused document factory', async () => {
    const [server, client] = loopback();
    const factory = vi.fn(() => new Editable());
    const onClose = vi.fn();
    const stop = serveDocument(server, factory, { onClose });
    cleanups.push(stop, serveModel(server, new Fixture()));
    const model = await connectModel(client);
    cleanups.push(() => model.close());
    expect((await model.load('bus')).labels).toEqual(['Bus 1', 'Bus 2']);
    expect(factory).not.toHaveBeenCalled();
    stop();
    stop();
    await settle(12);
    expect(factory).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['sync', 'async'] as const)(
    'opens a %s factory only after a valid open request',
    async (kind) => {
      const document = new Editable();
      const factory = vi.fn(() => (kind === 'sync' ? document : Promise.resolve(document)));
      const [server, client] = loopback();
      cleanups.push(serveDocument(server, factory));
      const calls = connect(client, DOCUMENT);
      cleanups.push(() => calls.close());
      const raw = calls as ReturnType<typeof connect<unknown, Reply>>;
      await expect(raw.call({ op: 'open', client: 42 })).rejects.toThrow();
      await expect(calls.call({ op: 'view' })).rejects.toThrow('Open the document');
      expect(factory).not.toHaveBeenCalled();
      expect(await calls.call({ op: 'open' })).toMatchObject({ kind: 'opened' });
      expect(await calls.call({ op: 'view' })).toMatchObject({ kind: 'view' });
      expect(factory).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['document', 'promise'] as const)(
    'keeps eager initialization for a supplied %s',
    async (kind) => {
      const document = new Editable();
      const on = vi.spyOn(document, 'on');
      const [server, client] = loopback();
      const source = kind === 'document' ? document : Promise.resolve(document);
      cleanups.push(serveDocument(server, source));
      await settle(12);
      expect(on).toHaveBeenCalledTimes(1);
      const session = await connectDocument(client);
      cleanups.push(() => session.close());
      await session.apply(set(5));
      expect(document.state.value).toBe(5);
      expect(on).toHaveBeenCalledTimes(1);
    },
  );

  it('shares initialization without letting one cancelled open cancel another', async () => {
    const document = new Editable();
    const on = vi.spyOn(document, 'on');
    let resolve!: (document: Document) => void;
    const pending = new Promise<Document>((done) => {
      resolve = done;
    });
    const factory = vi.fn(() => pending);
    const [server, client] = loopback();
    cleanups.push(serveDocument(server, factory));
    const calls = connect(client, DOCUMENT);
    cleanups.push(() => calls.close());
    const controller = new AbortController();
    const first = calls.call({ op: 'open' }, { signal: controller.signal });
    const second = calls.call({ op: 'open' });
    await settle(12);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(on).not.toHaveBeenCalled();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    resolve(document);
    expect(await second).toMatchObject({ kind: 'opened' });
    expect(on).toHaveBeenCalledTimes(1);
    expect(await calls.call({ op: 'view' })).toMatchObject({ kind: 'view' });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'reject'] as const)(
    'shares a factory %s failure for the service lifetime',
    async (kind) => {
      const factory = vi.fn((): Document | Promise<Document> => {
        const error = new Error('Cannot open the native file');
        if (kind === 'throw') throw error;
        return Promise.reject(error);
      });
      const [server, client] = loopback();
      const stop = serveDocument(server, factory);
      cleanups.push(stop);
      const calls = connect(client, DOCUMENT);
      cleanups.push(() => calls.close());
      await Promise.all([
        expect(calls.call({ op: 'open' })).rejects.toThrow('Cannot open the native file'),
        expect(calls.call({ op: 'open' })).rejects.toThrow('Cannot open the native file'),
      ]);
      await expect(calls.call({ op: 'open' })).rejects.toThrow('Cannot open the native file');
      expect(factory).toHaveBeenCalledTimes(1);
      stop();

      // A new registration makes its own attempt; failure is not cached by factory identity.
      factory.mockReturnValue(new Editable());
      const [nextServer, nextClient] = loopback();
      cleanups.push(serveDocument(nextServer, factory));
      const session = await connectDocument(nextClient);
      cleanups.push(() => session.close());
      expect(factory).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    'observes an eager promise rejection before any open (closed: %s)',
    async (closed) => {
      const [server, client] = loopback();
      const stop = serveDocument(server, Promise.reject(new Error('Native file failed')));
      cleanups.push(stop);
      if (closed) stop();
      // Cross an event-loop turn so an unobserved rejection would fail the test.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!closed) await expect(connectDocument(client)).rejects.toThrow('Native file failed');
    },
  );

  it('skips a scheduled factory when the service closes before invocation', async () => {
    const factory = vi.fn(() => new Editable());
    const [server, client] = loopback();
    const stop = serveDocument(server, factory);
    cleanups.push(stop);
    const calls = connect(client, DOCUMENT);
    cleanups.push(() => calls.close());
    const opening = calls.call({ op: 'open' });
    // The request lands first; closure runs before the factory's queued microtask.
    queueMicrotask(stop);
    await expect(opening).rejects.toThrow('closed');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['service', 'client', 'transport'] as const)(
    'does not acquire a late document after %s closure',
    async (closedBy) => {
      const document = new Editable();
      const on = vi.spyOn(document, 'on');
      let resolve!: (document: Document) => void;
      const pending = new Promise<Document>((done) => {
        resolve = done;
      });
      const factory = vi.fn(() => pending);
      const [server, client] = loopback();
      const onClose = vi.fn();
      const stop = serveDocument(server, factory, { onClose });
      cleanups.push(stop);
      const calls = connect(client, DOCUMENT);
      cleanups.push(() => calls.close());
      const opening = expect(calls.call({ op: 'open' })).rejects.toThrow(/closed|connection lost/);
      await settle(12);
      expect(factory).toHaveBeenCalledTimes(1);
      if (closedBy === 'service') stop();
      else if (closedBy === 'client') calls.close();
      else {
        server.fail('connection lost');
        client.fail('connection lost');
      }
      await opening;
      resolve(document);
      await settle(20);
      expect(on).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);

      // The host still owns the loaded document and can serve it elsewhere.
      const next = await setup(document);
      await next.session.apply(set(8));
      expect(document.state.value).toBe(8);
      expect(on).toHaveBeenCalledTimes(1);
    },
  );

  it('observes a factory rejection after closure', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<Document>((_resolve, fail) => {
      reject = fail;
    });
    const factory = vi.fn(() => pending);
    const [server, client] = loopback();
    const stop = serveDocument(server, factory);
    cleanups.push(stop);
    const opening = expect(connectDocument(client)).rejects.toThrow('closed');
    await settle(12);
    expect(factory).toHaveBeenCalledTimes(1);
    stop();
    await opening;
    reject(new Error('Native file failed after closure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('opens a cached view and applies, undoes, and redoes without leaking private history', async () => {
    const { session, document } = await setup();
    expect(session.view.schematic.positions).toBeInstanceOf(Float32Array);
    expect(session.view.schematic.positions[0]).toBeNaN();
    expect(session.partOf({ classId: 'bus', index: 1 })).toEqual({ kind: 'block', index: 1 });
    expect(session.elementAt({ kind: 'block', index: 0 })).toEqual({ classId: 'bus', index: 0 });
    const revisions: number[] = [];
    session.on('change', () => revisions.push(session.view.version.revision));
    expect(await session.apply(set(7))).toEqual({ label: 'Edit', scope: 'values', created: [] });
    expect(session.view.history.undo).toEqual([{ label: 'Edit', scope: 'values', created: [] }]);
    expect(document.history.undo[0]).toHaveProperty('privateInverse');
    expect([...(await session.bytes())]).toEqual([7]);
    await session.undo();
    expect([...(await session.bytes())]).toEqual([0]);
    await session.redo();
    expect([...(await session.bytes())]).toEqual([7]);
    expect(await session.apply(set(7))).toBeNull();
    expect(session.view.version.revision).toBe(3);
    expect(revisions).toEqual([1, 2, 3]);
  });

  it('preserves refusal locations and leaves refused transactions and history unchanged', async () => {
    const { session, document } = await setup();
    await expect(
      session.apply(set(9), {
        kind: 'remove',
        elements: [{ classId: 'bus', index: 1 }],
      }),
    ).rejects.toMatchObject({ name: 'Refusal', at: { classId: 'bus', index: 1 } });
    await expect(
      session.apply({ kind: 'record', classId: 'bus', signal: 'Vm', recorded: true }),
    ).rejects.toMatchObject({ name: 'Refusal', at: 'Vm' });
    expect(document.state.value).toBe(0);
    expect(session.view.version.revision).toBe(0);
    expect(session.view.history.undo).toEqual([]);
    await session.apply(set(1));
    expect(session.view.version.revision).toBe(1);
  });

  it('keeps layout updates compact, retains the netlist, and reuses its immutable model', async () => {
    const { session, server, document } = await setup();
    const sent = vi.spyOn(server, 'post');
    const initial = session.view.schematic.netlist;
    const first = await session.model();
    session.on('change', () => expect(session.view.schematic.netlist).toBe(initial));
    const columns = Float32Array.of(10, 20);
    await session.apply({
      kind: 'place',
      elements: [{ classId: 'bus', index: 0 }],
      positions: columns,
    });
    expect([...columns]).toEqual([10, 20]);
    expect([...session.view.schematic.positions].slice(0, 2)).toEqual([10, 20]);
    expect(document.schematic.positions.byteLength).toBe(16);
    expect(await session.model()).toBe(first);
    expect(document.models).toHaveLength(0);
    const updates = sent.mock.calls
      .map(([message]) => message as { kind: string; body: Update })
      .filter((message) => message.kind === 'event')
      .map((message) => message.body);
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].schematic)).toEqual(['positions']);
    first.close();
  });

  it('captures input and base revision at invocation, refusing queued stale indexes', async () => {
    const { session, document } = await setup();
    const insert = session.apply({ kind: 'insert', classId: 'bus', at: null });
    const stale = session.apply(set(8));
    const result = await Promise.allSettled([insert, stale]);
    expect(result[0].status).toBe('fulfilled');
    expect(result[1]).toMatchObject({ status: 'rejected', reason: { name: 'DocumentConflict' } });
    expect(document.state).toMatchObject({ count: 3, value: 0 });
    const positions = Float32Array.of(2, 3);
    const placing = session.apply({
      kind: 'place',
      elements: [{ classId: 'bus', index: 0 }],
      positions,
    });
    positions.fill(99);
    await placing;
    expect([...session.view.schematic.positions].slice(0, 2)).toEqual([2, 3]);
  });

  it('replays a receipt before checking revision, rejects reused identities, and bounds replay', async () => {
    const { calls, opened, document } = await rawSetup();
    const command: Request = {
      op: 'apply',
      client: opened.client,
      sequence: 1,
      base: opened.view.version,
      operations: [set(4)],
    };
    const receipt = await calls.call(command);
    expect(await calls.call({ ...command })).toEqual(receipt);
    await expect(calls.call({ ...command, operations: [set(5)] })).rejects.toThrow('reused');
    expect(document.applied).toBe(1);
    const view = await calls.call({ op: 'view' });
    if (view.kind !== 'view') throw new Error('not a view');
    await calls.call({ op: 'undo', client: opened.client, sequence: 2, base: view.view.version });
    expect(await calls.call(command)).toMatchObject({ kind: 'expired' });
    expect(document.state.value).toBe(0);
  });

  it('deduplicates no-ops and refusals, and reports stale epochs', async () => {
    const { calls, opened } = await rawSetup();
    const command = {
      op: 'apply' as const,
      client: opened.client,
      sequence: 1,
      base: opened.view.version,
      operations: [set(0)],
    };
    expect(await calls.call(command)).toMatchObject({ kind: 'accepted', change: null });
    expect(await calls.call(command)).toMatchObject({ kind: 'accepted', change: null });
    const refused = {
      ...command,
      sequence: 2,
      operations: [{ kind: 'remove' as const, elements: [{ classId: 'bus', index: 0 }] }],
    };
    expect(await calls.call(refused)).toMatchObject({ kind: 'refused' });
    expect(await calls.call(refused)).toMatchObject({ kind: 'refused' });
    expect(
      await calls.call({ ...command, sequence: 3, base: { epoch: 'another-owner', revision: 0 } }),
    ).toMatchObject({ kind: 'conflict' });
  });

  it.each([
    { lost: 'request', lazy: false },
    { lost: 'reply', lazy: false },
    { lost: 'request', lazy: true },
    { lost: 'reply', lazy: true },
  ] as const)(
    'recovers a lost $lost on a new transport without duplicating the edit (factory: $lazy)',
    async ({ lost, lazy }) => {
      const document = new Editable();
      const source = lazy ? () => document : document;
      const [server, client] = loopback();
      let disrupt = false;
      const fail = () => {
        server.fail('connection lost');
        client.fail('connection lost');
      };
      const serving: Port = {
        ...server,
        post(message, transfer) {
          const envelope = message as { kind: string; body?: { kind?: string } };
          if (disrupt && lost === 'reply' && envelope.kind === 'event') return;
          if (
            disrupt &&
            lost === 'reply' &&
            envelope.kind === 'reply' &&
            envelope.body?.kind === 'accepted'
          ) {
            fail();
            return;
          }
          server.post(message, transfer);
        },
      };
      const calling: Port = {
        ...client,
        post(message, transfer) {
          const envelope = message as { kind: string; body?: { op?: string } };
          if (
            disrupt &&
            lost === 'request' &&
            envelope.kind === 'call' &&
            envelope.body?.op === 'apply'
          ) {
            fail();
            return;
          }
          client.post(message, transfer);
        },
      };
      cleanups.push(serveDocument(serving, source));
      const session = await connectDocument(calling);
      cleanups.push(() => session.close());
      disrupt = true;
      await expect(session.apply(set(6))).rejects.toThrow('connection lost');
      const [nextServer, nextClient] = loopback();
      cleanups.push(serveDocument(nextServer, source));
      expect(await connectDocument(nextClient, { resume: session })).toBe(session);
      expect(document.applied).toBe(1);
      expect([...(await session.bytes())]).toEqual([6]);
      await session.apply(set(7));
      expect(document.applied).toBe(2);
    },
  );

  it('refreshes an observer after an event gap and never rolls its view backward', async () => {
    const { document, session } = await setup();
    const [server, client] = loopback();
    let saved: unknown;
    const filtered: Port = {
      ...server,
      post(message, transfer) {
        const envelope = message as { kind: string; body?: Update };
        if (envelope.kind === 'event' && envelope.body?.to.revision === 1) {
          saved = message;
          return;
        }
        server.post(message, transfer);
      },
    };
    cleanups.push(serveDocument(filtered, document));
    const observer = await connectDocument(client);
    cleanups.push(() => observer.close());
    await session.apply(set(1));
    await session.apply(set(2));
    await vi.waitFor(() => expect(observer.view.version.revision).toBe(2));
    server.post(saved);
    await settle(12);
    expect(observer.view.version.revision).toBe(2);
    expect([...(await observer.bytes())]).toEqual([2]);
  });

  it('rejects malformed and oversized commands before the vendor sees them', async () => {
    const { calls, opened, document } = await rawSetup();
    const raw = calls as ReturnType<typeof connect<unknown, Reply>>;
    const base = { client: opened.client, sequence: 1, base: opened.view.version };
    for (const request of [
      { ...base, op: 'nope' },
      { ...base, op: 'apply', operations: [{ ...set(1), value: {} }] },
      {
        ...base,
        op: 'apply',
        operations: [{ kind: 'place', elements: [], positions: Float32Array.of(1) }],
      },
      { ...base, op: 'apply', operations: Array.from({ length: 257 }, () => set(1)) },
      { ...base, op: 'undo', sequence: -1 },
      {
        ...base,
        op: 'apply',
        operations: Array.from({ length: 20 }, () => ({ ...set(1), column: 'x'.repeat(65536) })),
      },
    ])
      await expect(raw.call(request)).rejects.toThrow();
    expect(document.applied).toBe(0);
    expect((await calls.call({ ...base, op: 'apply', operations: [set(1)] })).kind).toBe(
      'accepted',
    );
  });

  it('serializes snapshot capture with edits, while other documents keep working', async () => {
    const { document, session } = await setup();
    await session.apply(set(1));
    let release!: () => void;
    document.opening = new Promise((resolve) => {
      release = resolve;
    });
    const snapshot = session.model();
    await settle(12);
    const editing = session.apply(set(2));
    const other = await setup();
    await other.session.apply(set(9));
    expect(document.state.value).toBe(1);
    release();
    const first = await snapshot;
    await editing;
    expect(new TextDecoder().decode(await first.bytes())).toBe('1');
    const second = await session.model();
    expect(new TextDecoder().decode(await second.bytes())).toBe('2');
    expect(first).not.toBe(second);
    first.close();
    second.close();
  });

  it('recovers a failed native snapshot without an edit, reconnect, or leaked model lease', async () => {
    class Flaky extends Editable {
      attempts = 0;
      protected override open(): Promise<Model> {
        if (++this.attempts === 1) return Promise.reject(new Error('Temporary model failure'));
        return super.open();
      }
    }
    const before = hosted.size;
    const document = new Flaky();
    const { session } = await setup(document);
    await session.apply(set(3));
    const version = session.view.version;
    await expect(session.model()).rejects.toThrow('Temporary model failure');
    expect(hosted.size).toBe(before);
    const model = await session.model();
    expect(new TextDecoder().decode(await model.bytes())).toBe('3');
    expect(await session.model()).toBe(model);
    expect(document.attempts).toBe(2);
    expect(session.view.version).toEqual(version);
    expect(session.view.history.undo).toHaveLength(1);
    expect(hosted.size).toBe(before + 1);
    model.close();
    await settle(12);
    expect(hosted.size).toBe(before);
  });

  it('records a captured model in its serving realm even after later edits', async () => {
    const { document, server, client, session } = await setup();
    await session.apply(set(3));
    const snapshot = await session.model();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new Scripted(async (_recorder, _input, model) => {
      await wait;
      expect(new TextDecoder().decode(await model.bytes())).toBe('3');
    });
    cleanups.push(serveEngine(server, engine));
    const remote = await connectEngine(client);
    cleanups.push(() => remote.close());
    const recording = remote.record(snapshot, null);
    await session.apply(set(4));
    release();
    await ended(recording);
    expect(recording.state.status).toBe('complete');
    expect(engine.models[0]).toBe(document.models[0]);
    snapshot.close();
  });

  it('cancels an edit waiting behind a read without consuming its sequence', async () => {
    const { document, calls, opened } = await rawSetup();
    await calls.call({
      op: 'apply',
      client: opened.client,
      sequence: 1,
      base: opened.view.version,
      operations: [set(1)],
    });
    const reply = await calls.call({ op: 'view' });
    if (reply.kind !== 'view') throw new Error('not a view');
    let release!: () => void;
    document.opening = new Promise((resolve) => {
      release = resolve;
    });
    const reading = calls.call({ op: 'model', base: reply.view.version });
    await settle(12);
    const controller = new AbortController();
    const command: Request = {
      op: 'apply',
      client: opened.client,
      sequence: 2,
      base: reply.view.version,
      operations: [set(2)],
    };
    const editing = calls.call(command, { signal: controller.signal });
    controller.abort();
    await expect(editing).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await reading;
    expect(document.state.value).toBe(1);
    expect((await calls.call(command)).kind).toBe('accepted');
  });

  it('releases model services on snapshot/session close and bounds retained snapshots', async () => {
    const before = hosted.size;
    const { session } = await setup();
    const snapshots: Document.Snapshot[] = [];
    for (let value = 1; value <= 32; value++) {
      await session.apply(set(value));
      snapshots.push(await session.model());
    }
    expect(hosted.size).toBe(before + 32);
    await session.apply(set(33));
    await expect(session.model()).rejects.toThrow('limit 32');
    snapshots[0].close();
    await settle(12);
    const next = await session.model();
    expect(hosted.size).toBe(before + 32);
    session.close();
    await settle(20);
    expect(hosted.size).toBe(before);
    await expect(next.bytes()).rejects.toThrow(/closed/);
  });

  it('expires detached clients safely instead of retrying against a fresh identity', async () => {
    const { document, session } = await setup();
    // A server close detaches the identity while leaving the facade resumable.
    const connections: (() => void)[] = [];
    for (let i = 0; i < 64; i++) {
      const [server, client] = loopback();
      const stop = serveDocument(server, document);
      connections.push(stop);
      const next = await connectDocument(client);
      next.close();
      await settle(12);
    }
    // Original client is still attached and cannot be evicted.
    await session.apply(set(1));
    connections.forEach((stop) => stop());
    const old = await rawSetup(document);
    old.calls.close();
    await settle(12);
    for (let i = 0; i < 64; i++) {
      const fresh = await rawSetup(document);
      fresh.calls.close();
      await settle(12);
    }
    const [server, client] = loopback();
    cleanups.push(serveDocument(server, document));
    const calls = connect(client, DOCUMENT);
    cleanups.push(() => calls.close());
    await expect(calls.call({ op: 'open', client: old.opened.client })).rejects.toThrow('expired');
  });

  it('works over a real MessageChannel without detaching live schematic or operation arrays', async () => {
    const channel = new MessageChannel();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const document = new Editable();
    cleanups.push(serveDocument(messagePort(channel.port1), document));
    const session = await connectDocument(messagePort(channel.port2));
    cleanups.push(() => session.close());
    const positions = Float32Array.of(4, 5);
    await session.apply({ kind: 'place', elements: [{ classId: 'bus', index: 0 }], positions });
    expect([...positions]).toEqual([4, 5]);
    expect(document.schematic.netlist.portStart.byteLength).toBe(12);
    expect(document.schematic.positions.byteLength).toBe(16);
    expect([...(await session.bytes())]).toEqual([0]);
    const inspected = await session.inspect('bus/0');
    expect(inspected.inspection?.ports[0].net?.key).toBe('signal/0');
    await session.apply(inspected.version, set(7));
    expect((await session.inspect('bus/0')).inspection?.values.kv).toBe(7);
  });

  it('rejects reads with a stale base as a typed document conflict', async () => {
    const { document, session } = await setup();
    document.apply(set(2));
    // The event is still in transit, so the read captures revision zero.
    await expect(session.bytes()).rejects.toBeInstanceOf(DocumentConflict);
    expect(session.view.version.revision).toBe(1);
  });

  it('requires opening and validates a peer view before exposing it', async () => {
    const { client } = await setup();
    const raw = connect(client, protocol<unknown, unknown>('document'));
    cleanups.push(() => raw.close());
    await expect(raw.call({ op: 'apply', operations: [] })).rejects.toThrow();
    const document = new Editable();
    document.schematic.positions[0] = NaN;
    const [server, target] = loopback();
    const malformed: Port = {
      ...server,
      post(message, transfer) {
        const envelope = message as { kind: string; body?: { kind: string; view: Document.View } };
        if (envelope.kind === 'reply' && envelope.body?.kind === 'opened')
          envelope.body.view = {
            ...envelope.body.view,
            schematic: { ...envelope.body.view.schematic, positions: new Float32Array(1) },
          };
        server.post(message, transfer);
      },
    };
    cleanups.push(serveDocument(malformed, document));
    await expect(connectDocument(target)).rejects.toThrow('inconsistent lengths');
  });
  it('cancels an unclaimed model download promptly and releases its service', async () => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class Slow extends Editable {
      protected override open(): Promise<Model> {
        return Promise.resolve(
          new Fixture('slow', {
            source: (own) => ({
              ...own,
              core: async () => {
                started();
                await gate;
                return own.core();
              },
            }),
          }),
        );
      }
    }
    const before = hosted.size;
    const { session } = await setup(new Slow());
    await session.apply(set(1));
    const controller = new AbortController();
    const opening = session.model(controller.signal);
    await entered;
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await settle(20);
    expect(hosted.size).toBe(before);
    release();
  });

  it('does not cancel a shared snapshot download when another reader still wants it', async () => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class Slow extends Editable {
      protected override open(): Promise<Model> {
        return Promise.resolve(
          new Fixture('shared', {
            source: (own) => ({
              ...own,
              core: async () => {
                started();
                await gate;
                return own.core();
              },
            }),
          }),
        );
      }
    }
    const { session } = await setup(new Slow());
    await session.apply(set(1));
    const controller = new AbortController();
    const cancelled = session.model(controller.signal);
    const kept = session.model();
    await entered;
    await settle(20);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    release();
    const model = await kept;
    expect(model.name).toBe('shared');
    expect((await model.load('bus')).labels).toHaveLength(2);
    model.close();
  });

  it('coalesces a slow observer to one pending event and refreshes its revision gap', async () => {
    const { document, session } = await setup();
    const [server, client] = loopback();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events = 0;
    const slow: Port = {
      ...server,
      drain: () => gate,
      post(message, transfer) {
        if ((message as { kind: string }).kind === 'event') events++;
        server.post(message, transfer);
      },
    };
    cleanups.push(serveDocument(slow, document));
    const observer = await connectDocument(client);
    cleanups.push(() => observer.close());
    for (let value = 1; value <= 20; value++) await session.apply(set(value));
    expect(events).toBe(0);
    release();
    await vi.waitFor(() => expect(observer.view.version.revision).toBe(20));
    expect(events).toBe(1);
  });

  it('does not reopen a session closed while reconnecting', async () => {
    const { document, session } = await setup();
    const [server, client] = loopback();
    cleanups.push(serveDocument(server, document));
    const reconnecting = connectDocument(client, { resume: session });
    session.close();
    await expect(reconnecting).rejects.toThrow('closed');
  });

  it('does not replay a pending command into a recreated document owner', async () => {
    const { session, stop } = await setup();
    const epoch = session.view.version.epoch;
    stop();
    await settle(12);
    const document = new Editable();
    const [server, client] = loopback();
    cleanups.push(serveDocument(server, document));
    await expect(connectDocument(client, { resume: session })).rejects.toThrow('expired');
    const fresh = await setup(document);
    expect(fresh.session.view.version.epoch).not.toBe(epoch);
    expect(document.applied).toBe(0);
  });

  it('rejects nonfinite client input before a byte transport can normalize it to null', async () => {
    const { session, document } = await setup();
    await expect(session.apply(set(Infinity))).rejects.toThrow('finite');
    expect(document.applied).toBe(0);
    await session.apply(set(2));
  });
  it('bounds retained command bytes and leaves a busy command sequence available for retry', async () => {
    const { document, calls, opened } = await rawSetup();
    const initial = { client: opened.client, sequence: 1, base: opened.view.version };
    const edited = await calls.call({ ...initial, op: 'apply', operations: [set(1)] });
    if (edited.kind !== 'accepted') throw new Error('not accepted');
    let release!: () => void;
    document.opening = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = calls.call({ op: 'model', base: edited.version });
    await settle(12);
    const operations = Array.from({ length: 14 }, () => ({ ...set(1), column: 'x'.repeat(65536) }));
    const commands = Array.from({ length: 10 }, (_, index) => ({
      op: 'apply' as const,
      client: opened.client,
      sequence: index + 2,
      base: edited.version,
      operations,
    }));
    const pending = commands.map((command) => calls.call(command));
    expect(await pending[9]).toMatchObject({ kind: 'busy' });
    release();
    await reading;
    const replies = await Promise.all(pending);
    expect(replies.slice(0, 9).every((reply) => reply.kind === 'accepted')).toBe(true);
    expect((await calls.call(commands[9])).kind).toBe('accepted');
    expect(document.applied).toBe(1);
  });
});

describe('document inspection', () => {
  it('reads native values and complete wiring by element or key without opening a model', async () => {
    const { document, session, client } = await setup();
    const model = vi.spyOn(document, 'model');
    const events = vi.fn();
    session.on('change', events);
    const sent = vi.spyOn(client, 'post');
    const first = await session.inspect({ classId: 'bus', index: 0 });
    expect(first).toEqual({
      version: session.view.version,
      inspection: {
        element: { classId: 'bus', index: 0 },
        key: 'bus/0',
        values: { kv: 0, enabled: true, label: 'Bus', limit: null },
        ports: [
          { name: 'voltage', net: { element: { classId: 'signal', index: 0 }, key: 'signal/0' } },
          { name: 'unused', net: null },
        ],
        members: [],
      },
    });
    expect(await session.inspect('bus/0')).toEqual(first);
    expect(session.partOf({ classId: 'signal', index: 0 })).toBeNull();
    const net = await session.inspect('signal/0');
    expect(net.inspection?.members).toEqual([
      { owner: { element: { classId: 'bus', index: 0 }, key: 'bus/0' }, port: 'voltage' },
      { owner: { element: { classId: 'bus', index: 1 }, key: 'bus/1' }, port: 'voltage' },
    ]);
    expect(
      sent.mock.calls.map(([message]) => (message as { body: { op: string } }).body.op),
    ).toEqual(['inspect', 'inspect', 'inspect']);
    expect(events).not.toHaveBeenCalled();
    expect(session.view.history).toEqual({ undo: [], redo: [] });
    await session.apply(first.version, set(3));
    expect((await session.inspect('bus/0')).inspection?.values.kv).toBe(3);
    await session.undo();
    expect((await session.inspect('bus/0')).inspection?.values.kv).toBe(0);
    await session.redo();
    expect((await session.inspect('bus/0')).inspection?.values.kv).toBe(3);
    expect(first.inspection?.values.kv).toBe(0);
    expect(first.version.revision).toBe(0);
    expect(model).not.toHaveBeenCalled();
  });

  it('distinguishes missing elements from anonymous elements and follows structural undo', async () => {
    const { session, document } = await setup();
    expect((await session.inspect('bus/2')).inspection).toBeNull();
    expect((await session.inspect({ classId: 'missing', index: 0 })).inspection).toBeNull();
    await session.apply({ kind: 'insert', classId: 'bus', at: null });
    expect((await session.inspect('bus/2')).inspection?.element.index).toBe(2);
    await session.undo();
    expect((await session.inspect('bus/2')).inspection).toBeNull();
    await session.redo();
    expect((await session.inspect('bus/2')).inspection?.element.index).toBe(2);
    const anonymous = { ...document.inspect({ classId: 'bus', index: 0 })!, key: null };
    vi.spyOn(document, 'inspect').mockReturnValue(anonymous);
    expect((await session.inspect({ classId: 'bus', index: 0 })).inspection).toEqual(anonymous);
  });

  it('rejects a retained draft on the owner even when the local view has already advanced', async () => {
    const { session, document } = await setup();
    const draft = await session.inspect('bus/0');
    const other = await setup(document);
    await other.session.apply(set(5));
    await settle(12);
    expect(session.view.version.revision).toBe(1);
    await expect(session.apply(draft.version, set(9))).rejects.toMatchObject({
      name: 'DocumentConflict',
      expected: draft.version,
      actual: session.view.version,
    });
    expect(document.state.value).toBe(5);
    await session.apply(set(6));
    expect(document.state.value).toBe(6);
    const foreign = { ...session.view.version, epoch: 'another-owner' };
    await expect(session.apply(foreign, set(9))).rejects.toBeInstanceOf(DocumentConflict);
    const current = { ...session.view.version };
    const editing = session.apply(current, set(7));
    current.revision = 99;
    await editing;
    expect(document.state.value).toBe(7);
  });

  it('captures inspection targets at invocation and rejects stale reads before resolving indexes', async () => {
    const { document, session } = await setup();
    const target = { classId: 'bus', index: 0 };
    const reading = session.inspect(target);
    target.index = 999;
    expect((await reading).inspection?.element.index).toBe(0);
    const inspect = vi.spyOn(document, 'inspect');
    document.apply(set(2));
    await expect(session.inspect('bus/0')).rejects.toBeInstanceOf(DocumentConflict);
    expect(inspect).not.toHaveBeenCalled();
    expect(session.view.version.revision).toBe(1);
  });

  it('serializes inspection with edits and cancels queued reads before native inspection', async () => {
    const { document, session } = await setup();
    await session.apply(set(1));
    let release!: () => void;
    document.opening = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = session.model();
    await settle(12);
    const inspect = vi.spyOn(document, 'inspect');
    const controller = new AbortController();
    const cancelled = session.inspect('bus/0', controller.signal);
    await settle(12);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const editing = session.apply(set(2));
    await settle(12);
    const stale = session.inspect('bus/0');
    const rejected = expect(stale).rejects.toBeInstanceOf(DocumentConflict);
    release();
    (await capture).close();
    await editing;
    await rejected;
    expect(inspect).not.toHaveBeenCalled();
    expect((await session.inspect('bus/0')).inspection?.values.kv).toBe(2);
    await expect(session.inspect('bus/0', AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    session.close();
    await expect(session.inspect('bus/0')).rejects.toThrow('closed');
  });

  it('copies only public fields without retaining or exposing provider-owned objects', async () => {
    const { document, session } = await setup();
    const native = {
      element: { classId: 'bus', index: 0, privateIndex: new Map() },
      key: 'bus/0',
      values: { kv: 4, ['__proto__']: 'ordinary column' },
      ports: [
        {
          name: 'voltage',
          net: { element: { classId: 'signal', index: 0 }, key: 'signal/0', secret: true },
        },
      ],
      members: [
        {
          owner: { element: { classId: 'bus', index: 1 }, key: 'bus/1', secret: true },
          port: 'voltage',
        },
      ],
      privateFunction() {},
    };
    vi.spyOn(document, 'inspect').mockReturnValue(native);
    const { inspection } = await session.inspect('bus/0');
    expect(inspection).not.toHaveProperty('privateFunction');
    expect(inspection!.element).not.toHaveProperty('privateIndex');
    expect(inspection!.ports[0].net).not.toHaveProperty('secret');
    expect(inspection!.members[0].owner).not.toHaveProperty('secret');
    expect(inspection!.values['__proto__']).toBe('ordinary column');
    native.values.kv = 8;
    native.element.index = 8;
    expect(inspection!.values.kv).toBe(4);
    expect(inspection!.element.index).toBe(0);
    Object.assign(inspection!.values, { kv: 12 });
    Object.assign(inspection!.ports[0].net!.element, { index: 12 });
    expect(native.values.kv).toBe(8);
    expect(native.ports[0].net.element.index).toBe(0);
  });

  it('rejects malformed inspection requests before calling the native adapter', async () => {
    const { document, client, opened } = await rawSetup();
    const inspect = vi.spyOn(document, 'inspect');
    const raw = connect(client, protocol<unknown, unknown>('document'));
    cleanups.push(() => raw.close());
    for (const target of [
      null,
      [],
      { classId: 'bus', index: -1 },
      { classId: 'bus', index: 0.5 },
      'x'.repeat(65537),
    ]) {
      await expect(
        raw.call({ op: 'inspect', base: opened.view.version, target }),
      ).rejects.toThrow();
    }
    await expect(
      raw.call({ op: 'inspect', base: { epoch: '', revision: 0 }, target: 'bus/0' }),
    ).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('validates native scalars and bounds before a byte transport can normalize or send them', async () => {
    const { document, session } = await setup();
    const native = document.inspect({ classId: 'bus', index: 0 })!;
    const inspect = vi.spyOn(document, 'inspect');
    for (const value of [Infinity, NaN]) {
      inspect.mockReturnValue({ ...native, values: { kv: value } });
      await expect(session.inspect('bus/0')).rejects.toThrow('finite');
    }
    inspect.mockReturnValue({
      ...native,
      values: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [String(i), 1])),
    });
    await expect(session.inspect('bus/0')).rejects.toThrow('4096');
    inspect.mockReturnValue({
      ...native,
      ports: Array.from({ length: 4097 }, () => ({ name: 'p', net: null })),
    });
    await expect(session.inspect('bus/0')).rejects.toThrow('4096');
    inspect.mockReturnValue({
      ...native,
      values: Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [String(i), 'x'.repeat(65536)]),
      ),
    });
    await expect(session.inspect('bus/0')).rejects.toThrow('1 MiB');
    inspect.mockReturnValue(native);
    expect((await session.inspect('bus/0')).inspection).toEqual(native);
  });

  it.each(['values', 'ports', 'members', 'revision'] as const)(
    'validates peer inspection %s before exposing them',
    async (fault) => {
      const [server, client] = loopback();
      const malformed: Port = {
        ...server,
        post(message, transfer) {
          const envelope = message as {
            kind: string;
            body: { kind: string; version: Document.Version; inspection: Record<string, unknown> };
          };
          if (envelope.kind === 'reply' && envelope.body?.kind === 'inspection') {
            if (fault === 'revision')
              envelope.body.version = { ...envelope.body.version, revision: 99 };
            else if (fault === 'values') envelope.body.inspection.values = { kv: [] };
            else if (fault === 'ports')
              envelope.body.inspection.ports = [{ name: 'p', net: { key: 'signal/0' } }];
            else
              envelope.body.inspection.members = [
                { owner: { element: { classId: 'bus', index: -1 }, key: null }, port: 'p' },
              ];
          }
          server.post(message, transfer);
        },
      };
      cleanups.push(serveDocument(malformed, new Editable()));
      const session = await connectDocument(client);
      cleanups.push(() => session.close());
      await expect(session.inspect('bus/0')).rejects.toThrow();
    },
  );
});
