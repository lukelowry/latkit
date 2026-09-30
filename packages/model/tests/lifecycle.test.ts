import { describe, expect, it } from 'vitest';
import type {
  CommandEvent,
  MonitorConfig,
  QueryBlock,
  SamplesBlock,
  SamplesQuery,
} from '../src/index.js';
import { blockBuffers, blockByteLength, validateBlock, validateSchema } from '../src/index.js';
import { collect, failure, FixtureModel, readOnlyDocument } from './fixture.js';

import { axisLength, axisValues } from './source.js';

const rowsQuery = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const sampleQuery = (offset = 0, count = 1): SamplesQuery => ({
  kind: 'samples',
  from: 'Node',
  select: ['output'],
  window: { kind: 'frames', offset, count },
});
function config(scope: MonitorConfig['scope']): MonitorConfig {
  return {
    scope,
    fields: [{ from: 'Node', select: ['output'] }],
    retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
  };
}
function first(block: SamplesBlock): number {
  const col = block.columns.output;
  return col.values[col.offset];
}

describe('implementer and host usage', () => {
  it('uses a hardcoded read-only document with optional source and no extra owner', async () => {
    const document = readOnlyDocument();
    expect(document.edit).toBeUndefined();
    expect(validateSchema(await document.describe())).toEqual([]);
    const blocks = await collect(document.query(rowsQuery));
    expect(blocks.flatMap((b) => axisValues(b.rows))).toEqual([0, 1, 2, 3]);
  });
  it('uses pull backpressure, releases early, and retains the first-pull version across edits', async () => {
    const model = new FixtureModel();
    const iterator = model.document.query(rowsQuery)[Symbol.asyncIterator]();
    expect(model.document.pulls).toBe(0);
    expect((await iterator.next()).value.kind).toBe('schema');
    expect(model.document.pulls).toBe(0);
    const firstBlock = (await iterator.next()).value as QueryBlock;
    expect(model.document.pulls).toBe(1);
    await model.document.edit([{ kind: 'set', id: 'n3', values: { value: 99 } }]);
    const second = (await iterator.next()).value as QueryBlock;
    expect(second.version).toBe(firstBlock.version);
    await iterator.return?.();
    expect(model.document.released).toBe(1);
    expect((await collect(model.document.query(rowsQuery)))[0].version).not.toBe(
      firstBlock.version,
    );
    const early = model.document.query(rowsQuery)[Symbol.asyncIterator]();
    await early.next();
    const before = model.document.pulls;
    await early.return?.();
    expect(model.document.pulls).toBe(before);
    expect(model.document.released).toBe(3);
  });
  it('abort releases the active iteration without closing the document', async () => {
    const model = new FixtureModel();
    const controller = new AbortController();
    const iterator = model.document
      .query(rowsQuery, { signal: controller.signal })
      [Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
    expect(model.document.released).toBe(1);
    expect(await collect(model.document.query(rowsQuery))).toHaveLength(2);
  });
  it('borrows contiguous data, gathers sparse data, and gives owned callers independent buffers', async () => {
    const model = new FixtureModel();
    const borrowed = await collect(model.document.query(rowsQuery));
    expect(blockBuffers(borrowed[0])).toContain(model.document.state.values.buffer);
    expect(model.document.copiedBytes).toBe(0);
    const sparse = await collect(
      model.document.query({
        ...rowsQuery,
        rows: {
          kind: 'indices',
          index: model.document.state.index,
          values: new Uint32Array([3, 0]),
        },
      }),
    );
    expect(model.document.copiedBytes).toBe(16);
    expect(sparse[0].columns.value.kind).toBe('numeric');
    const owned = await collect(model.document.query(rowsQuery, { buffers: 'owned' }));
    expect(blockBuffers(owned[0])).not.toContain(model.document.state.values.buffer);
    const buffers = blockBuffers(owned[0]) as ArrayBuffer[];
    structuredClone(owned[0], { transfer: buffers });
    expect(model.document.state.values.byteLength).toBe(32);
    expect(blockBuffers(owned[1]).every((buffer) => buffer.byteLength > 0)).toBe(true);
    expect(blockByteLength(borrowed[0])).toBeLessThan(4096);
  });
  it('evaluates assertions before mutation and commits all or none with native identities', async () => {
    const model = new FixtureModel();
    const originalIndex = model.document.state.index;
    const change = await model.document.edit([
      { kind: 'set', id: 'n1', values: { value: 10 } },
      { kind: 'assert', id: 'n1', values: { value: 1 } },
    ]);
    expect(change.changed).toBe(true);
    expect(model.document.state.index).toBe(originalIndex);
    const version = model.document.version;
    await expect(
      model.document.edit([
        { kind: 'set', id: 'n2', values: { value: 20 } },
        { kind: 'assert', id: 'n1', values: { value: 1 } },
      ]),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(model.document.version).toBe(version);
    expect([...model.document.state.values]).toEqual([10, 2, 3, 4]);
    const added = await model.document.edit([
      { kind: 'add-component', as: 'new', type: 'Node', values: { value: 5 } },
      { kind: 'set', id: { local: 'new' }, values: { value: 6 } },
    ]);
    expect(added.created.new).toBe('n5');
    expect(model.document.state.index.version).not.toBe(originalIndex.version);
    await expect(
      collect(
        model.document.query({
          ...rowsQuery,
          rows: { kind: 'indices', index: originalIndex, values: new Uint32Array([0]) },
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('command-scoped monitoring', () => {
  it('arms without pinning, then binds to accepted inputs before queued notification', async () => {
    const model = new FixtureModel();
    const capture = await model.monitor(config({ kind: 'command', id: 'a' }));
    expect(capture.status).toBe('armed');
    expect(capture.documentVersion).toBeNull();
    await expect(capture.describe()).rejects.toMatchObject({ code: 'busy' });
    await model.document.edit([{ kind: 'set', id: 'n1', values: { value: 7 } }]);
    const acceptedVersion = model.document.version;
    const events: CommandEvent[] = [];
    model.on('command', (event) => {
      events.push(event);
      expect(capture.documentVersion).toBe(acceptedVersion);
    });
    const completion = model.call({ routine: 'solve', values: {} }, { id: 'a' });
    expect(capture.source.inputs()).toBe(model.document.state);
    model.start('a');
    model.complete('a');
    await completion;
    expect(events.map((e) => e.kind)).toEqual(['queued', 'running', 'complete']);
    expect(first((await collect(capture.query(sampleQuery())))[0])).toBe(7);
    expect(await capture.done).toEqual({ status: 'stopped', reason: 'command-finished' });
  });
  it('isolates parallel outputs, shares pinned inputs, and survives edit plus open', async () => {
    const model = new FixtureModel();
    const a = await model.monitor(config({ kind: 'command', id: 'a' }));
    const b = await model.monitor(config({ kind: 'command', id: 'b' }));
    const live = await model.monitor(config({ kind: 'live' }));
    const pa = model.call({ routine: 'solve', values: {} }, { id: 'a' });
    const pb = model.call({ routine: 'solve', values: {} }, { id: 'b' });
    expect(a.source.inputs()).toBe(b.source.inputs());
    const pinned = a.source.inputs();
    await model.document.edit([{ kind: 'set', id: 'n1', values: { value: 100 } }]);
    await model.document.replace();
    expect(a.status).toBe('monitoring');
    expect(b.status).toBe('monitoring');
    expect(await live.done).toEqual({ status: 'stopped', reason: 'document-changed' });
    model.complete('b', 3);
    model.complete('a', 2);
    await Promise.all([pa, pb]);
    expect(first((await collect(a.query(sampleQuery())))[0])).toBe(2);
    expect(first((await collect(b.query(sampleQuery())))[0])).toBe(3);
    expect(a.source.inputs()).toBe(pinned);
    expect(live.frameCount).toBe(0);
    expect((await a.commands({ limit: 10 })).items.map((e) => e.id)).toEqual(['a']);
    expect((await b.commands({ limit: 10 })).items.map((e) => e.id)).toEqual(['b']);
  });
  it('stopping capture does not cancel its command and leaves frozen provenance', async () => {
    const model = new FixtureModel();
    const capture = await model.monitor(config({ kind: 'command', id: 'a' }));
    const completion = model.call({ routine: 'solve', values: {} }, { id: 'a' });
    await capture.stop();
    expect(model.work.has('a')).toBe(true);
    model.complete('a');
    await completion;
    expect(capture.frameCount).toBe(0);
    expect((await capture.commands({ limit: 1 })).items[0].status).toBe('queued');
  });
  it('distinguishes command failure from capture failure, including rejected acceptance', async () => {
    const model = new FixtureModel();
    const capture = await model.monitor(config({ kind: 'command', id: 'a' }));
    const completion = model.call({ routine: 'solve', values: {} }, { id: 'a' });
    const rejected = expect(completion).rejects.toMatchObject({ code: 'internal' });
    model.complete('a', 1, failure('internal'));
    await rejected;
    expect(await capture.done).toMatchObject({ status: 'stopped', reason: 'command-finished' });
    expect((await capture.commands({ limit: 1 })).items[0].status).toBe('failed');
    const invalid = await model.monitor(config({ kind: 'command', id: 'bad' }));
    await expect(
      model.call({ routine: 'missing', values: {} }, { id: 'bad' }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(await invalid.done).toMatchObject({
      status: 'failed',
      error: { code: 'invalid-input' },
    });
  });
  it('cancels commands, rejects reused IDs, and resets without replacing the document', async () => {
    const model = new FixtureModel();
    const document = model.document;
    const controller = new AbortController();
    const completion = model.call(
      { routine: 'solve', values: {} },
      { id: 'a', signal: controller.signal },
    );
    const rejected = expect(completion).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();
    await rejected;
    await expect(model.call({ routine: 'solve', values: {} }, { id: 'a' })).rejects.toMatchObject({
      code: 'conflict',
    });
    const armed = await model.monitor(config({ kind: 'command', id: 'later' }));
    await model.reset();
    expect(model.document).toBe(document);
    expect(armed.status).toBe('stopped');
    expect(await armed.done).toMatchObject({ reason: 'model-reset' });
    await model.close();
    await model.close();
    await expect(model.document.replace()).rejects.toMatchObject({ code: 'closed' });
  });
});

describe('retention and tiled reads', () => {
  it('bounds long live capture, preserves logical frame numbers, and keeps borrowed blocks alive', async () => {
    const model = new FixtureModel();
    const capture = await model.monitor({
      ...config({ kind: 'live' }),
      retain: { kind: 'rolling', bytes: 80, frames: 2, onLimit: 'fail' },
    });
    model.live(0);
    const old = (await collect(capture.query(sampleQuery())))[0];
    for (let t = 1; t < 1000; t++) model.live(t);
    expect(capture.firstFrame).toBe(998);
    expect(capture.frameCount).toBe(1000);
    await expect(collect(capture.query(sampleQuery()))).rejects.toMatchObject({ code: 'expired' });
    const q = sampleQuery(998, 2);
    const tiles = await collect(capture.query(q, { maxBlockBytes: 1024 }));
    const cells = new Set<string>();
    for (const tile of tiles) {
      expect(validateBlock(await capture.describe(), q, tile, { maxBlockBytes: 1024 })).toEqual([]);
      for (let i = 0; i < tile.coordinates.length; i++)
        for (let j = 0; j < axisLength(tile.rows); j++) {
          const cell = tile.firstFrame + i + ':' + (tile.rowOffset + j);
          expect(cells.has(cell)).toBe(false);
          cells.add(cell);
        }
    }
    expect(cells.size).toBe(8);
    expect(capture.source.copiedBytes).toBe(0);
    await capture.close();
    expect(first(old)).toBe(1);
    await expect(collect(capture.query(q))).rejects.toMatchObject({ code: 'closed' });
  });
  it.each(['stop', 'fail'] as const)(
    'admits complete frames and applies the %s limit policy',
    async (onLimit) => {
      const model = new FixtureModel();
      const capture = await model.monitor({
        ...config({ kind: 'live' }),
        retain: { kind: 'all', bytes: 40, onLimit },
      });
      model.live(0);
      model.live(1);
      expect(capture.frameCount).toBe(1);
      expect(await capture.done).toMatchObject(
        onLimit === 'stop'
          ? { status: 'stopped', reason: 'limit' }
          : { status: 'failed', error: { code: 'resource-limit' } },
      );
      expect(first((await collect(capture.query(sampleQuery())))[0])).toBe(1);
    },
  );
});
