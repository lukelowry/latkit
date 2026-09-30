import { describe, expect, it } from 'vitest';
import type { Document, MonitorConfig } from '@latkit/model-new';
import {
  FixtureService,
  MemoryFile,
  collect,
  byteStream,
  readBytes,
} from '../../model_new/tests/fixture.js';
import { open, deferred } from './fixture.js';
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const config = (id: string): MonitorConfig => ({
  scope: { kind: 'command', id },
  fields: [{ from: 'Node', select: ['output'] }],
  retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
});
async function firstId(document: Document): Promise<string> {
  const block = (await collect(document.query({ ...rows, ids: true })))[0];
  const ids = block.ids!;
  return new TextDecoder().decode(ids.bytes.subarray(ids.offsets[0], ids.offsets[1]));
}
describe.each([false, true])('transport framing=%s', (framed) => {
  it('shares document state across peers without sharing compute lifetimes', async () => {
    const service = new FixtureService();
    const host = await open(service, framed);
    const page = await open(service, framed);
    try {
      const a = await host.remote.open();
      const b = await page.remote.document(a.id);
      const first = await host.remote.model(a.id);
      const second = await page.remote.model(a.id);
      const changed = deferred<void>();
      b.on('change', () => {
        expect(b.version).not.toBe('1');
        changed.resolve();
      });
      await a.edit!([{ kind: 'set', id: await firstId(a), values: { value: 5 } }]);
      await changed.promise;
      const version = b.version;
      await first.reset();
      expect(b.version).toBe(version);
      await first.close();
      await a.close();
      expect(await b.describe()).toBeDefined();
      await second.close();
      await b.close();
      await expect(page.remote.document(a.id)).rejects.toMatchObject({ code: 'closed' });
    } finally {
      await host.close();
      await page.close();
    }
  });
  it('preserves armed readiness, command correlation and retained failure details', async () => {
    const connection = await open(undefined, framed);
    try {
      const document = await connection.remote.open();
      const model = await connection.remote.model(document.id);
      const recording = await model.monitor!(config('a'));
      expect(recording.status).toBe('armed');
      let bound = false;
      void recording.ready.then(() => {
        bound = true;
      });
      await Promise.resolve();
      expect(bound).toBe(false);
      const queued = deferred<void>();
      model.on('command', (event) => {
        if (event.kind === 'queued') queued.resolve();
      });
      const completed = model.call!({ routine: 'solve', values: {} }, { id: 'a' });
      await queued.promise;
      await recording.ready;
      expect(recording.documentVersion).toBe(document.version);
      expect(recording.axis?.name).toBe('time');
      connection.service.models[0].complete('a');
      await completed;
      expect(await recording.done).toMatchObject({ reason: 'command-finished' });
      expect((await recording.commands({ limit: 10 })).items[0].status).toBe('complete');
      const invalid = await model.monitor!(config('bad'));
      const readiness = expect(invalid.ready).rejects.toMatchObject({ code: 'invalid-input' });
      await expect(
        model.call!({ routine: 'missing', values: {} }, { id: 'bad' }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      await readiness;
      expect(await invalid.done).toMatchObject({
        status: 'failed',
        error: { code: 'invalid-input' },
      });
      await model.close();
      await document.close();
    } finally {
      await connection.close();
    }
  });
  it('cancels a pending query pull and releases the producer on iterator return', async () => {
    const connection = await open(undefined, framed);
    try {
      const document = await connection.remote.open();
      const source = connection.service.documents.get(document.id)!;
      const iterator = document.query(rows)[Symbol.asyncIterator]();
      await iterator.next();
      source.readGate = new Promise(() => {});
      const pending = expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
      await iterator.return?.();
      await pending;
      expect(source.released).toBe(1);
      source.readGate = undefined;
      expect(await collect(document.query(rows))).toHaveLength(2);
      await document.close();
    } finally {
      await connection.close();
    }
  });
  it('cancels queued and running commands while preserving the model', async () => {
    const connection = await open(undefined, framed);
    try {
      const document = await connection.remote.open();
      const model = await connection.remote.model(document.id);
      for (const running of [false, true]) {
        const controller = new AbortController();
        const id = String(running);
        const queued = deferred<void>();
        const off = model.on('command', (event) => {
          if (event.id === id && event.kind === 'queued') queued.resolve();
        });
        const completed = model.call!(
          { routine: 'solve', values: {} },
          { id, signal: controller.signal },
        );
        const rejected = expect(completed).rejects.toMatchObject({ code: 'aborted' });
        await queued.promise;
        if (running) connection.service.models[0].start(id);
        controller.abort();
        await rejected;
        off();
      }
      await model.reset();
      await model.close();
      await document.close();
    } finally {
      await connection.close();
    }
  });
  it('moves bounded content streams and exports without detaching supplied chunks', async () => {
    const connection = await open(undefined, framed, {
      limits: { maxInFlightBytes: 16 * 1024, maxMetadataBytes: 2048 },
    });
    const data = new TextEncoder().encode(
      JSON.stringify(Array.from({ length: 5000 }, (_, i) => i)),
    );
    try {
      const document = await connection.remote.open({
        kind: 'content',
        stream: byteStream(data),
        mediaType: 'application/json',
      });
      expect(data.length).toBeGreaterThan(16000);
      const exported = await document.export!();
      expect(await readBytes(exported.stream)).toEqual(data);
      expect(data.byteLength).toBeGreaterThan(16000);
      await document.close();
    } finally {
      await connection.close();
    }
  });
  it('enforces active stream limits and recovers after early release', async () => {
    const connection = await open(undefined, framed, {
      limits: { maxStreams: 1, maxReferences: 12 },
    });
    try {
      const document = await connection.remote.open();
      const first = document.query(rows)[Symbol.asyncIterator]();
      await first.next();
      await expect(document.query(rows)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: 'resource-limit',
      });
      await first.return?.();
      for (let i = 0; i < 20; i++) expect(await collect(document.query(rows))).toHaveLength(2);
      await document.close();
    } finally {
      await connection.close();
    }
  });
  it('preserves independent owned blocks under a tight payload bound', async () => {
    const connection = await open(undefined, framed);
    try {
      const document = await connection.remote.open();
      const blocks = await collect(document.query(rows, { buffers: 'owned', maxBlockBytes: 300 }));
      const first = blocks[0].columns.value;
      if (first.kind !== 'numeric') throw new Error('numeric');
      structuredClone(first.values, { transfer: [first.values.buffer as ArrayBuffer] });
      const second = blocks[1].columns.value;
      if (second.kind !== 'numeric') throw new Error('numeric');
      expect([...second.values]).toEqual([3, 4]);
      expect(connection.service.documents.get(document.id)!.state.values.byteLength).toBe(32);
      await document.close();
    } finally {
      await connection.close();
    }
  });
});
it('revokes host storage on disconnect and explicitly reattaches it without replacing shared edits', async () => {
  const service = new FixtureService();
  const file = new MemoryFile();
  const host = await open(service);
  const page = await open(service);
  let replacement: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const original = await host.remote.open({ kind: 'resource', resource: file.grant() });
    const document = await page.remote.document(original.id);
    await document.edit!([{ kind: 'set', id: await firstId(document), values: { value: 9 } }]);
    const version = document.version;
    await host.close();
    expect(file.closedGrants).toBe(1);
    expect(await collect(document.query(rows))).toHaveLength(2);
    await expect(document.save!()).rejects.toMatchObject({ code: 'closed' });
    replacement = await open(service);
    const attached = await replacement.remote.document(document.id);
    await attached.attach!(file.grant());
    expect(attached.version).toBe(version);
    await document.save!();
    expect(new TextDecoder().decode(file.bytes!)).toBe('[9,2,3,4]');
    await attached.close();
    await document.close();
  } finally {
    await host.close();
    await page.close();
    await replacement?.close();
  }
});
it('rejects unsettled recordings and pending operations when transport disappears', async () => {
  const connection = await open();
  const document = await connection.remote.open();
  const model = await connection.remote.model(document.id);
  const recording = await model.monitor!(config('unused'));
  const ready = expect(recording.ready).rejects.toMatchObject({ code: 'disconnected' });
  const done = expect(recording.done).rejects.toMatchObject({ code: 'disconnected' });
  const closed = expect(connection.remote.closed).rejects.toMatchObject({ code: 'disconnected' });
  await connection.server.close();
  await Promise.all([ready, done, closed]);
  await expect(connection.serving).rejects.toMatchObject({ code: 'disconnected' });
  await connection.remote.close();
});

it('pins a fresh version for each iteration of the same query', async () => {
  const connection = await open();
  try {
    const document = await connection.remote.open();
    const query = document.query(rows);
    const before = await collect(query);
    await document.edit!([{ kind: 'set', id: await firstId(document), values: { value: 10 } }]);
    const after = await collect(query);
    expect(after).toHaveLength(2);
    expect(after[0].version).not.toBe(before[0].version);
    await document.close();
  } finally {
    await connection.close();
  }
});
