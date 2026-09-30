import { expect, it } from 'vitest';
import type { Command, Document, Model, ModelService, Resource } from '@latkit/model-new';
import { connect, serve } from '../src/index.js';
import {
  FixtureModel,
  FixtureService,
  MemoryFile,
  collect,
  readBytes,
} from '../../model_new/tests/fixture.js';
import { open, transports, deferred } from './fixture.js';
const failure = (code: 'busy' | 'unsupported' | 'invalid-input') =>
  Object.assign(new Error(code), { code });
it('supports a live-only exclusive peer without formats, editing, parsing or persistence', async () => {
  const native = new FixtureService();
  let active: FixtureModel | undefined;
  const readonly = (document: Document): Document => ({
    id: document.id,
    name: document.name,
    format: null,
    saved: null,
    get version() {
      return document.version;
    },
    describe: document.describe.bind(document),
    query: document.query.bind(document),
    on: document.on.bind(document),
    close: document.close.bind(document),
  });
  const service: ModelService = {
    id: 'peer',
    label: 'Live peer',
    formats: [],
    async open(input) {
      if (input) throw failure('unsupported');
      return readonly(await native.open());
    },
    async document(id) {
      return readonly(await native.document(id));
    },
    async model(id): Promise<Model> {
      if (active) throw failure('busy');
      const model = await native.model(id);
      active = model;
      return {
        id: model.id,
        label: model.label,
        documentId: id,
        routines: model.routines.filter((r) => r.mode === 'live'),
        monitor: model.monitor.bind(model),
        reset: model.reset.bind(model),
        on: model.on.bind(model),
        call(command, options) {
          const id = options?.id ?? crypto.randomUUID();
          const done = model.call(command, { ...options, id });
          queueMicrotask(() => model.complete(id));
          return done;
        },
        async close() {
          await model.close();
          if (active === model) active = undefined;
        },
      };
    },
  };
  const [client, server] = transports();
  const serving = serve(server, service);
  void serving.catch(() => undefined);
  const remote = await connect(client);
  try {
    expect(remote.formats).toEqual([]);
    const document = await remote.open();
    expect(document.format).toBeNull();
    expect(document.edit).toBeUndefined();
    expect(document.save).toBeUndefined();
    const model = await remote.model(document.id);
    expect(model.parse).toBeUndefined();
    expect(model.routines.map((r) => r.mode)).toEqual(['live']);
    await expect(remote.model(document.id)).rejects.toMatchObject({ code: 'busy' });
    const recording = await model.monitor!({
      scope: { kind: 'live' },
      fields: [{ from: 'Node', select: ['output'] }],
      retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
    });
    await recording.ready;
    await model.call!({ routine: 'adjust', values: {} });
    active!.live(1);
    const blocks = await collect(
      recording.query({
        kind: 'samples',
        from: 'Node',
        select: ['output'],
        window: { kind: 'frames', offset: 0, count: 2 },
      }),
    );
    expect(blocks).toHaveLength(4);
    await model.close();
    expect((await recording.done).status).toBe('stopped');
    const replacement = await remote.model(document.id);
    await replacement.close();
    await document.close();
  } finally {
    await remote.close();
    await serving;
  }
});
it('validates input metadata without locking content or consuming resource grants', async () => {
  const service = new FixtureService();
  const original = service.model.bind(service);
  service.model = async (id) =>
    Object.assign(await original(id), {
      validate: async (command: Command) => {
        expect(command.values.file).toMatchObject({ kind: 'content', name: 'values.json' });
        return [];
      },
    });
  const connection = await open(service, false, { limits: { maxReferences: 12, maxStreams: 2 } });
  const file = new MemoryFile();
  let pulled = 0,
    cancelled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled++;
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  try {
    const document = await connection.remote.open();
    const model = await connection.remote.model(document.id);
    const command: Command = {
      routine: 'solve',
      values: {
        file: { kind: 'content', name: 'values.json', stream },
        resource: { kind: 'resource', resource: file.grant() },
      },
    };
    for (let i = 0; i < 20; i++) expect(await model.validate!(command)).toEqual([]);
    expect(stream.locked).toBe(false);
    expect(pulled).toBe(0);
    expect(cancelled).toBe(0);
    expect(file.closedGrants).toBe(0);
    await model.close();
    await document.close();
  } finally {
    await connection.close();
  }
  await stream.cancel();
});
it('cancels a pending reverse content pull and recovers the connection', async () => {
  const connection = await open();
  const started = deferred();
  const cancelled = deferred();
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        started.resolve();
      },
      cancel() {
        cancelled.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  try {
    const opening = connection.remote.open(
      { kind: 'content', stream },
      { signal: controller.signal },
    );
    const failed = expect(opening).rejects.toMatchObject({ code: 'aborted' });
    await started.promise;
    controller.abort();
    await failed;
    await cancelled.promise;
    expect(stream.locked).toBe(false);
    const document = await connection.remote.open();
    await document.close();
  } finally {
    await connection.close();
  }
});
it('preserves failure targets and issues and closes grants after rejected opening', async () => {
  const connection = await open();
  const file = new MemoryFile('bad', 'not json');
  try {
    await expect(
      connection.remote.open({ kind: 'resource', resource: file.grant() }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(file.closedGrants).toBe(1);
    const document = await connection.remote.open();
    const source = connection.service.documents.get(document.id)!;
    source.edit = async () => {
      throw Object.assign(failure('invalid-input'), {
        target: { kind: 'element', id: 'x' },
        issues: [{ code: 'constraint', message: 'Invalid domain value', edit: 0 }],
      });
    };
    await expect(document.edit!([])).rejects.toMatchObject({
      code: 'invalid-input',
      target: { kind: 'element', id: 'x' },
      issues: [{ code: 'constraint', edit: 0 }],
    });
    await document.close();
  } finally {
    await connection.close();
  }
});
it('keeps read-only resource capabilities and exact byte ranges through reverse callbacks', async () => {
  const service = new FixtureService();
  let borrowed: Resource | undefined;
  const original = service.open.bind(service);
  service.open = async (input, options) => {
    if (input?.kind === 'resource') {
      borrowed = input.resource;
      expect(borrowed.write).toBeUndefined();
      const info = (await borrowed.stat())!;
      expect(
        new TextDecoder().decode(
          await readBytes(await borrowed.read({ tag: info.tag, range: { offset: 1, length: 3 } })),
        ),
      ).toBe('1,2');
      await expect(borrowed.read({ tag: 'old' })).rejects.toMatchObject({ code: 'conflict' });
    }
    return original(input, options);
  };
  const connection = await open(service);
  const file = new MemoryFile();
  try {
    const document = await connection.remote.open({
      kind: 'resource',
      resource: file.grant(false),
    });
    await expect(document.save!()).rejects.toMatchObject({ code: 'unsupported' });
    await document.close();
    expect(file.closedGrants).toBe(1);
    await expect(borrowed!.stat()).rejects.toMatchObject({ code: 'closed' });
  } finally {
    await connection.close();
  }
});
it('reclaims nested recordings when their model closes', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 8 } });
  try {
    const document = await connection.remote.open();
    for (let i = 0; i < 20; i++) {
      const model = await connection.remote.model(document.id);
      const recording = await model.monitor!({
        scope: { kind: 'live' },
        fields: [{ from: 'Node', select: ['output'] }],
        retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
      });
      await recording.ready;
      await model.close();
      expect((await recording.done).status).toBe('stopped');
      expect(recording.status).toBe('closed');
    }
    await document.close();
  } finally {
    await connection.close();
  }
});

it('unwinds partial input setup without leaving locked streams or references', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 6, maxStreams: 2 } });
  const locked = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
  const reader = locked.getReader();
  try {
    const document = await connection.remote.open();
    const model = await connection.remote.model(document.id);
    for (let i = 0; i < 10; i++) {
      const cancelled = deferred();
      const first = new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelled.resolve();
          },
        },
        { highWaterMark: 0 },
      );
      await expect(
        model.call!({
          routine: 'solve',
          values: {
            first: { kind: 'content', stream: first },
            second: { kind: 'content', stream: locked },
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      await cancelled.promise;
      expect(first.locked).toBe(false);
    }
    await model.close();
    await document.close();
  } finally {
    reader.releaseLock();
    await connection.close();
  }
});
it('closes newly created native models if the connection cannot publish another reference', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 2 } });
  try {
    const document = await connection.remote.open();
    for (let i = 0; i < 5; i++) {
      await expect(connection.remote.model(document.id)).rejects.toMatchObject({
        code: 'resource-limit',
      });
      expect(() => connection.service.models.at(-1)!.check()).toThrow();
    }
    expect(await document.describe()).toBeDefined();
    await document.close();
  } finally {
    await connection.close();
  }
});

it('releases recordings after repeated resets while retaining the model and document', async () => {
  const connection = await open(undefined, false, { limits: { maxReferences: 6 } });
  try {
    const document = await connection.remote.open();
    const model = await connection.remote.model(document.id);
    for (let i = 0; i < 10; i++) {
      const recording = await model.monitor!({
        scope: { kind: 'live' },
        fields: [{ from: 'Node', select: ['output'] }],
        retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
      });
      await recording.ready;
      await model.reset();
      expect(recording.status).toBe('closed');
      expect(await recording.done).toMatchObject({ reason: 'reset' });
    }
    await model.close();
    await document.close();
  } finally {
    await connection.close();
  }
});
it('closes grants and cancels content when opening is already aborted', async () => {
  const connection = await open();
  const file = new MemoryFile();
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(
      connection.remote.open(
        { kind: 'resource', resource: file.grant() },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(file.closedGrants).toBe(1);
    const cancelled = deferred();
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      connection.remote.open({ kind: 'content', stream }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    await cancelled.promise;
    expect(stream.locked).toBe(false);
  } finally {
    await connection.close();
  }
});
