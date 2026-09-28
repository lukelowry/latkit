import { afterEach, describe, expect, it, vi } from 'vitest';
import { Document, DocumentConflict, Refusal, type Model } from '@latkit/model';

import {
  connect,
  connectDocument,
  connectEngine,
  loopback,
  messagePort,
  protocol,
  serveDocument,
  serveEngine,
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
  keyOf(element: Model.Element): string {
    return `${element.classId}/${element.index}`;
  }
  find(key: string): Model.Element | null {
    const index = Number(key.split('/')[1]);
    return index < this.state.count ? { classId: 'bus', index } : null;
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

  it.each(['request', 'reply'] as const)(
    'recovers a lost %s on a new transport without duplicating the edit',
    async (lost) => {
      const document = new Editable();
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
      cleanups.push(serveDocument(serving, document));
      const session = await connectDocument(calling);
      cleanups.push(() => session.close());
      disrupt = true;
      await expect(session.apply(set(6))).rejects.toThrow('connection lost');
      const [nextServer, nextClient] = loopback();
      cleanups.push(serveDocument(nextServer, document));
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
    const remote = connectEngine(client);
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
