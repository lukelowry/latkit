import { describe, expect, it } from 'vitest';
import { FixtureService, FixtureDocument, MemoryFile, collect, readBytes } from './fixture.js';
import type { Document, WritePart } from '../src/index.js';
const rows = { kind: 'rows', from: 'Node', select: ['value'] } as const;
async function firstId(document: Document): Promise<string> {
  const block = (await collect(document.query({ ...rows, ids: true })))[0];
  const ids = block.ids!;
  return new TextDecoder().decode(ids.bytes.subarray(ids.offsets[0], ids.offsets[1]));
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('shared documents', () => {
  it('gives acquisitions separate lifetimes and models independent reset', async () => {
    const service = new FixtureService();
    const a = await service.open();
    const b = await service.document(a.id);
    const first = await service.model(a.id);
    const second = await service.model(a.id);
    const id = await firstId(a);
    await a.edit!([{ kind: 'set', id, values: { value: 8 } }]);
    expect(b.version).toBe(a.version);
    await a.close();
    await expect(a.describe()).rejects.toMatchObject({ code: 'closed' });
    expect(await b.describe()).toBeDefined();
    const version = b.version;
    await first.reset();
    expect(b.version).toBe(version);
    expect(second.document.state.values[0]).toBe(8);
    await b.close();
    const reacquired = await service.document(a.id);
    await reacquired.close();
    await first.close();
    await second.close();
    await expect(service.document(a.id)).rejects.toMatchObject({ code: 'closed' });
  });
  it('does not cancel a document read when a model resets', async () => {
    const service = new FixtureService();
    const document = (await service.open()) as FixtureDocument;
    const model = await service.model(document.id);
    const waiting = gate();
    document.readGate = waiting.promise;
    const iterator = document.query(rows)[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    await model.reset();
    waiting.resolve();
    expect((await pending).done).toBe(false);
    await iterator.return?.();
    await model.close();
    await document.close();
  });
  it('shares edits and invalidates every affected live model while preserving isolated work', async () => {
    const service = new FixtureService();
    const document = await service.open();
    const a = await service.model(document.id),
      b = await service.model(document.id);
    const config = {
      scope: { kind: 'live' },
      fields: [{ from: 'Node', select: ['output'] }],
      retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
    } as const;
    const x = await a.monitor(config),
      y = await b.monitor(config);
    const isolated = a.call({ routine: 'solve', values: {} }, { id: 'isolated' });
    await document.edit!([{ kind: 'set', id: await firstId(document), values: { value: 4 } }]);
    expect(await x.done).toMatchObject({ reason: 'document-changed' });
    expect(await y.done).toMatchObject({ reason: 'document-changed' });
    a.complete('isolated');
    await isolated;
    await a.close();
    await b.close();
    await document.close();
  });
});
describe('resource persistence', () => {
  it('streams unchanged ranges locally and publishes saved metadata to all acquisitions', async () => {
    const file = new MemoryFile();
    const service = new FixtureService();
    const a = await service.open({ kind: 'resource', resource: file.grant() });
    const b = await service.document(a.id);
    const seen: unknown[] = [];
    b.on('saved', (value) => seen.push(value));
    await a.edit!([{ kind: 'set', id: await firstId(a), values: { value: 9 } }]);
    const saved = await a.save!();
    expect(saved).toEqual(b.saved);
    expect(seen).toEqual([saved]);
    expect(new TextDecoder().decode(file.bytes!)).toBe('[9,2,3,4]');
    expect(
      file.writes[0]
        .filter((part) => part.kind === 'data')
        .reduce((n, part) => n + part.bytes.length, 0),
    ).toBe(1);
    await a.close();
    expect(file.closedGrants).toBe(0);
    await b.close();
    expect(file.closedGrants).toBe(1);
  });
  it('pins save inputs while edits continue and serializes later saves', async () => {
    const service = new FixtureService();
    const file = new MemoryFile();
    const document = await service.open({ kind: 'resource', resource: file.grant() });
    const id = await firstId(document);
    const waiting = gate();
    file.writeGate = waiting.promise;
    await document.edit!([{ kind: 'set', id, values: { value: 7 } }]);
    const version = document.version;
    const first = document.save!();
    await document.edit!([{ kind: 'set', id, values: { value: 8 } }]);
    const second = document.save!();
    waiting.resolve();
    expect((await first).version).toBe(version);
    expect((await second).version).toBe(document.version);
    expect(new TextDecoder().decode(file.bytes!)).toBe('[8,2,3,4]');
    await document.close();
  });
  it('rejects stale writes and dirty reloads, while attach preserves the baseline', async () => {
    const file = new MemoryFile();
    const service = new FixtureService();
    const document = await service.open({ kind: 'resource', resource: file.grant() });
    const saved = document.saved;
    await document.edit!([{ kind: 'set', id: await firstId(document), values: { value: 7 } }]);
    file.replace('[5,6]');
    await document.attach!(file.grant());
    expect(document.saved).toBe(saved);
    await expect(document.save!()).rejects.toMatchObject({ code: 'conflict' });
    await expect(document.reload!()).rejects.toMatchObject({ code: 'conflict' });
    await document.reload!({ discardChanges: true });
    expect(document.saved?.version).toBe(document.version);
    expect(await readBytes((await document.export!()).stream)).toEqual(file.bytes);
    await document.close();
  });
  it('does not commit partial writes or a base that changes while staging', async () => {
    const file = new MemoryFile();
    const resource = file.grant();
    const before = file.bytes;
    async function* broken(): AsyncGenerator<WritePart> {
      yield { kind: 'data', bytes: new Uint8Array([1]) };
      throw new Error('interrupted');
    }
    await expect(resource.write!({ base: file.info!.tag, parts: broken() })).rejects.toThrow(
      'interrupted',
    );
    expect(file.bytes).toBe(before);
    const waiting = gate();
    file.writeGate = waiting.promise;
    async function* data(): AsyncGenerator<WritePart> {
      yield { kind: 'data', bytes: new Uint8Array([2]) };
    }
    const write = resource.write!({ base: file.info!.tag, parts: data() });
    const rejected = expect(write).rejects.toMatchObject({ code: 'conflict' });
    file.replace('[6]');
    waiting.resolve();
    await rejected;
    expect(new TextDecoder().decode(file.bytes!)).toBe('[6]');
    await resource.close();
  });
  it('preserves the prior destination after failed retargeting', async () => {
    const service = new FixtureService();
    const file = new MemoryFile();
    const document = await service.open({ kind: 'resource', resource: file.grant() });
    const target = new MemoryFile('target');
    const saved = document.saved;
    await expect(
      document.save!({ to: { resource: target.grant(), base: null } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(document.saved).toBe(saved);
    expect(target.closedGrants).toBe(1);
    await document.close();
  });
});

it.each([false, true])(
  'preserves edits arriving during reload with discardChanges=%s',
  async (discardChanges) => {
    const file = new MemoryFile();
    const resource = file.grant();
    const originalRead = resource.read;
    const started = gate(),
      resume = gate();
    let pause = false;
    const grant = {
      ...resource,
      async read(...args: Parameters<typeof resource.read>) {
        const stream = await originalRead(...args);
        if (pause) {
          started.resolve();
          await resume.promise;
        }
        return stream;
      },
    };
    const service = new FixtureService();
    const document = await service.open({ kind: 'resource', resource: grant });
    file.replace('[5,6]');
    pause = true;
    const reloading = document.reload!({ discardChanges });
    const rejected = expect(reloading).rejects.toMatchObject({ code: 'conflict' });
    await started.promise;
    await document.edit!([{ kind: 'set', id: await firstId(document), values: { value: 9 } }]);
    const version = document.version,
      saved = document.saved;
    resume.resolve();
    await rejected;
    expect(document.version).toBe(version);
    expect(document.saved).toBe(saved);
    expect(new TextDecoder().decode(await readBytes((await document.export!()).stream))).toBe(
      '[9,2,3,4]',
    );
    await document.close();
  },
);
it('closes unsupported and cancelled destination grants without changing the saved baseline', async () => {
  const service = new FixtureService();
  const file = new MemoryFile();
  const target = new MemoryFile('target');
  const document = await service.open({ kind: 'resource', resource: file.grant() });
  const saved = document.saved;
  await expect(
    document.save!({ to: { resource: target.grant(false), base: target.info!.tag } }),
  ).rejects.toMatchObject({ code: 'unsupported' });
  const controller = new AbortController();
  controller.abort();
  await expect(
    document.save!({
      signal: controller.signal,
      to: { resource: target.grant(), base: target.info!.tag },
    }),
  ).rejects.toMatchObject({ code: 'aborted' });
  expect(target.closedGrants).toBe(2);
  expect(document.saved).toBe(saved);
  await document.close();
});
