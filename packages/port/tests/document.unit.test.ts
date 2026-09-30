import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentConflict, type Document, type Engine, type Model } from '@latkit/model';

import {
  connect,
  connectEngine,
  loopback,
  messagePort,
  protocol,
  serveEngine,
  type Port,
} from '../src/index.js';
import { documentProtocol, type Reply, type Update } from '../src/document-protocol.js';
import { hosted } from '../src/model.js';
import { Editable, ended, Fixture, memory, Scripted, set, settle } from './fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

/** The engine's own cases protocol, as a raw peer speaks it. */
const CASES = protocol<unknown, { readonly session: string }>('engine:cases');

/**
 * An engine keeping one case, `a.case`, which opens as `document`; `idleBytes` is its budget for
 * clean cases no one uses.
 */
function keeping(document: Editable, idleBytes?: number): Scripted {
  const format: Document.Format = {
    id: 'test',
    label: 'Test',
    extensions: ['.case'],
    open: () => Promise.resolve(document),
  };
  return new Scripted(async () => undefined, {
    formats: [format],
    cases: memory({ 'a.case': [0] }).store,
    ...(idleBytes === undefined ? {} : { idleBytes }),
  });
}

/** A peer of `engine`, its side of the port through `wrap`, with a session on `a.case`. */
async function peer(engine: Engine, wrap: (server: Port) => Port = (server) => server) {
  const [server, client] = loopback();
  cleanups.push(serveEngine(wrap(server), engine));
  const remote = await connectEngine(client);
  cleanups.push(() => void remote.close());
  const session = await remote.open('a.case');
  cleanups.push(() => session.close());
  return { server, client, remote, session };
}

async function setup(document = new Editable(), idleBytes?: number) {
  const engine = keeping(document, idleBytes);
  return { document, engine, ...(await peer(engine)) };
}

/** A peer that speaks the document protocol itself, its session opened. */
async function rawSetup(document = new Editable()) {
  const engine = keeping(document);
  const [server, client] = loopback();
  cleanups.push(serveEngine(server, engine));
  const cases = connect(client, CASES);
  const { session } = await cases.call({ op: 'open', name: 'a.case' });
  const calls = connect(client, documentProtocol(session));
  cleanups.push(() => {
    calls.close();
    cases.close();
  });
  const opened = await calls.call({ op: 'open' });
  if (opened.kind !== 'opened') throw new Error('not opened');
  return { document, engine, server, client, session, calls, opened };
}

/** The document updates a side posted. */
function updatesOf(sent: { mock: { calls: unknown[][] } }): Update[] {
  return sent.mock.calls
    .map(([message]) => message as { kind: string; svc: string; body: Update })
    .filter((message) => message.kind === 'event' && message.svc.startsWith('document:'))
    .map((message) => message.body);
}

describe('case sessions across a port', () => {
  it('opens a view and applies, undoes, and redoes without leaking private history', async () => {
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
    expect(document.models).toEqual([]);
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

  it('shares the one document and its first model across peers, keeping snapshots after edits', async () => {
    const { session, document, engine } = await setup();
    const { session: other } = await peer(engine);
    expect(document.models).toEqual([]);
    const [first, second] = await Promise.all([session.model(), other.model()]);
    expect(document.models).toHaveLength(1);
    const decode = async (model: Model) => new TextDecoder().decode(await model.bytes());
    expect(await decode(first)).toBe('0');
    expect(await decode(second)).toBe('0');
    await session.apply(set(7));
    await vi.waitFor(() => expect(other.view.version.revision).toBe(1));
    const next = await other.model();
    expect(document.models).toHaveLength(2);
    expect(await decode(next)).toBe('7');
    expect(await decode(first)).toBe('0');
    expect(await decode(second)).toBe('0');
    first.close();
    second.close();
    next.close();
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
    expect(document.models).toHaveLength(1);
    const updates = updatesOf(sent);
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]!.schematic)).toEqual(['positions']);
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

  it('refuses an edit sent again after it landed, so none applies twice', async () => {
    const { calls, opened, document } = await rawSetup();
    const edit = { op: 'apply' as const, base: opened.view.version, operations: [set(4)] };
    expect(await calls.call(edit)).toEqual({
      kind: 'accepted',
      version: { ...opened.view.version, revision: 1 },
      change: { label: 'Edit', scope: 'values', created: [] },
    });
    expect(await calls.call(edit)).toEqual({
      kind: 'conflict',
      version: { ...opened.view.version, revision: 1 },
    });
    expect(
      await calls.call({ ...edit, operations: [set(0)], base: { epoch: 'x', revision: 1 } }),
    ).toMatchObject({ kind: 'conflict' });
    expect(document.applied).toBe(1);
    expect(document.state.value).toBe(4);
  });

  it('refreshes an observer after an event gap and never rolls its view backward', async () => {
    const { engine, session } = await setup();
    let held: unknown;
    let release!: () => void;
    const { session: observer } = await peer(engine, (server) => ({
      ...server,
      post(message, transfer) {
        const envelope = message as { kind: string; body?: Update };
        if (envelope.kind === 'event' && envelope.body?.to?.revision === 1) {
          release = () => server.post(message, transfer);
          held = message;
          return;
        }
        server.post(message, transfer);
      },
    }));
    await session.apply(set(1));
    await session.apply(set(2));
    await vi.waitFor(() => expect(observer.view.version.revision).toBe(2));
    expect(held).toBeDefined();
    release();
    await settle(12);
    expect(observer.view.version.revision).toBe(2);
    expect([...(await observer.bytes())]).toEqual([2]);
  });

  it('rejects malformed commands before the document sees them', async () => {
    const { calls, opened, document } = await rawSetup();
    const raw = calls as ReturnType<typeof connect<unknown, Reply>>;
    const base = { base: opened.view.version };
    for (const request of [
      { ...base, op: 'nope' },
      { ...base, op: 'apply', operations: [{ ...set(1), value: {} }] },
      {
        ...base,
        op: 'apply',
        operations: [{ kind: 'place', elements: [], positions: Float32Array.of(1) }],
      },
      { ...base, op: 'apply', operations: Array.from({ length: 257 }, () => set(1)) },
      { op: 'undo', base: { epoch: '', revision: 0 } },
      { op: 'apply', operations: [set(1)] },
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

  it('records a captured model where the engine holds it, even after later edits', async () => {
    const document = new Editable();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new Scripted(
      async (_recorder, _input, model) => {
        await wait;
        expect(new TextDecoder().decode(await model.bytes())).toBe('3');
      },
      {
        formats: [{ id: 'test', label: 'Test', extensions: ['.case'], open: async () => document }],
        cases: memory({ 'a.case': [0] }).store,
      },
    );
    const { remote, session } = await peer(engine);
    await session.apply(set(3));
    const snapshot = await session.model();
    const recording = remote.record(snapshot, null);
    await session.apply(set(4));
    release();
    await ended(recording);
    expect(recording.state.status).toBe('complete');
    expect(engine.models[0]).toBe(document.models[0]);
    snapshot.close();
  });

  it('releases model services on snapshot and session close, and bounds retained snapshots', async () => {
    const before = hosted.size;
    const { session } = await setup();
    const snapshots: Model[] = [];
    for (let value = 1; value <= 32; value++) {
      await session.apply(set(value));
      snapshots.push(await session.model());
    }
    expect(hosted.size).toBe(before + 32);
    await session.apply(set(33));
    await expect(session.model()).rejects.toThrow('limit 32');
    snapshots[0]!.close();
    await settle(12);
    const next = await session.model();
    expect(hosted.size).toBe(before + 32);
    session.close();
    await settle(20);
    expect(hosted.size).toBe(before);
    await expect(next.bytes()).rejects.toThrow(/closed/);
  });

  it('lets the engine let a case go once its last session closes', async () => {
    const { engine, session, remote } = await setup(new Editable(), 0);
    await session.apply(set(5));
    await remote.save('a.case', session.view.version);
    expect((await remote.cases())[0]!.saved).toEqual(session.view.version);
    session.close();
    await vi.waitFor(async () => expect((await engine.cases())[0]!.saved).toBeNull());
    const again = await remote.open('a.case');
    cleanups.push(() => again.close());
    expect([...(await again.bytes())]).toEqual([5]);
  });

  it('tells every peer on a case what its engine keeps, whichever saved it', async () => {
    const { engine, session, remote } = await setup();
    const { session: other } = await peer(engine);
    expect(other.view.saved).toEqual(other.view.version);
    const heard = vi.fn();
    other.on('saved', heard);
    await session.apply(set(3));
    await vi.waitFor(() => expect(other.view.version.revision).toBe(1));
    expect(other.view.saved).not.toEqual(other.view.version);
    await remote.save('a.case', session.view.version);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith(session.view.version));
    expect(other.view.saved).toEqual(other.view.version);
    await vi.waitFor(() => expect(session.view.saved).toEqual(session.view.version));
  });

  it('works over a real MessageChannel without detaching live schematic or operation arrays', async () => {
    const channel = new MessageChannel();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const document = new Editable();
    cleanups.push(serveEngine(messagePort(channel.port1), keeping(document)));
    const remote = await connectEngine(messagePort(channel.port2));
    cleanups.push(() => void remote.close());
    const session = await remote.open('a.case');
    const positions = Float32Array.of(4, 5);
    await session.apply({ kind: 'place', elements: [{ classId: 'bus', index: 0 }], positions });
    expect([...positions]).toEqual([4, 5]);
    expect(document.schematic.netlist.portStart.byteLength).toBe(12);
    expect(document.schematic.positions.byteLength).toBe(16);
    expect([...(await session.bytes())]).toEqual([0]);
    const inspected = await session.inspect('bus/0');
    expect(inspected.inspection?.ports[0]!.net?.key).toBe('signal/0');
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

  it('requires opening once and validates a peer view before exposing it', async () => {
    const [opening, peerSide] = loopback();
    cleanups.push(serveEngine(opening, keeping(new Editable())));
    const cases = connect(peerSide, CASES);
    const { session: id } = await cases.call({ op: 'open', name: 'a.case' });
    const raw = connect(peerSide, protocol<unknown, unknown>(`document:${id}`));
    cleanups.push(() => {
      raw.close();
      cases.close();
    });
    await expect(raw.call({ op: 'view' })).rejects.toThrow('Open the document');
    expect(await raw.call({ op: 'open' })).toMatchObject({ kind: 'opened' });
    await expect(raw.call({ op: 'open' })).rejects.toThrow('already open');
    const document = new Editable();
    const engine = keeping(document);
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
    cleanups.push(serveEngine(malformed, engine));
    const remote = await connectEngine(target);
    cleanups.push(() => void remote.close());
    await expect(remote.open('a.case')).rejects.toThrow('inconsistent lengths');
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
    const { engine, session } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events = 0;
    let slow = false;
    const { session: observer } = await peer(engine, (server) => ({
      ...server,
      drain: () => (slow ? gate : Promise.resolve()),
      post(message, transfer) {
        const envelope = message as { kind: string; svc: string };
        if (envelope.kind === 'event' && envelope.svc.startsWith('document:')) events++;
        server.post(message, transfer);
      },
    }));
    slow = true;
    for (let value = 1; value <= 20; value++) await session.apply(set(value));
    expect(events).toBe(0);
    release();
    await vi.waitFor(() => expect(observer.view.version.revision).toBe(20));
    expect(events).toBe(1);
  });

  it('rejects nonfinite client input before a byte transport can normalize it to null', async () => {
    const { session, document } = await setup();
    await expect(session.apply(set(Infinity))).rejects.toThrow('finite');
    expect(document.applied).toBe(0);
    await session.apply(set(2));
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

  it('rejects a retained draft even when the local view has already advanced', async () => {
    const { session, document, engine } = await setup();
    const draft = await session.inspect('bus/0');
    const other = await peer(engine);
    await other.session.apply(set(5));
    await vi.waitFor(() => expect(session.view.version.revision).toBe(1));
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
    expect(inspection!.ports[0]!.net).not.toHaveProperty('secret');
    expect(inspection!.members[0]!.owner).not.toHaveProperty('secret');
    expect(inspection!.values['__proto__']).toBe('ordinary column');
    native.values.kv = 8;
    native.element.index = 8;
    expect(inspection!.values.kv).toBe(4);
    expect(inspection!.element.index).toBe(0);
    Object.assign(inspection!.values, { kv: 12 });
    Object.assign(inspection!.ports[0]!.net!.element, { index: 12 });
    expect(native.values.kv).toBe(8);
    expect(native.ports[0]!.net.element.index).toBe(0);
  });

  it('rejects malformed inspection requests before calling the native adapter', async () => {
    const { document, calls, opened } = await rawSetup();
    const inspect = vi.spyOn(document, 'inspect');
    const raw = calls as ReturnType<typeof connect<unknown, Reply>>;
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
      const engine = keeping(new Editable());
      const { session } = await peer(engine, (server) => ({
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
      }));
      await expect(session.inspect('bus/0')).rejects.toThrow();
    },
  );
});
