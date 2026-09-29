import { describe, expect, it, vi } from 'vitest';

import { Refusal, type Engine, type Model } from '@latkit/model';

import {
  connect,
  connectEngine,
  connectModel,
  loopback,
  protocol,
  serve,
  serveEngine,
  serveModel,
} from '../src/index.js';
import { ended, Fixture, fixture, FRAMES, kept, Scripted, settle } from './fixture.js';

const SIMULATION: Engine.Study = {
  id: 'simulation',
  label: 'Simulation',
  formats: ['test'],
  groups: [{ id: 'fault', label: 'Fault', switch: 'off' }],
  parameters: [
    { id: 'tmax', kind: 'number', label: 'End time', above: 0, default: 10 },
    { id: 'bus', group: 'fault', kind: 'element', classId: 'bus', label: 'Bus' },
  ],
};

const SWEEP: Engine.Study = {
  id: 'sweep',
  label: 'Sweep',
  parameters: [{ id: 'bus', kind: 'element', classId: 'bus', label: 'Bus', each: true }],
};

const IMPORT: Engine.Study = {
  id: 'import',
  label: 'Import',
  parameters: [{ id: 'results', kind: 'file', label: 'Results', extensions: ['arrow'] }],
};

/** Both of the buses at one frame. */
const WINDOW = { frameOffset: 0, frameCount: 1, elementOffset: 0, elementCount: 2 };

/** A file's text, read as its stream gives it. */
async function textOf(file: Engine.File): Promise<string> {
  const reader = file.stream().getReader();
  let text = '';
  for (let read = await reader.read(); !read.done; read = await reader.read())
    text += new TextDecoder().decode(read.value);
  return text;
}

/** A scripted engine that reads a saved file's text as an end time. */
class Reader extends Scripted {
  readonly files: string[] = [];

  async read(model: Model, file: Engine.File): Promise<Engine.Input> {
    this.files.push(`${model.name}: ${file.name}`);
    return { study: 'simulation', values: { tmax: Number(await textOf(file)) } };
  }
}

describe('engine service', () => {
  it('records a model its realm serves where it lives, filling a recording on the far side', async () => {
    const [modelServer, modelClient] = loopback();
    const [engineServer, engineClient] = loopback();
    const served = fixture();
    const engine = new Scripted(async (recorder) => {
      recorder.wait(2);
      recorder.start();
      recorder.declare({ span: [0, 1], expectedFrames: 2 });
      await recorder.ready;
      recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
      recorder.log('warn', 'step halved');
    });
    const source = vi.spyOn(served, 'source');
    serveModel(modelServer, served);
    serveEngine(engineServer, engine);
    const model = await connectModel(modelClient);
    const remote = await connectEngine(engineClient);
    const opens = source.mock.calls.length;

    const recording = remote.record(model, { app: 'dynamic' }, { id: 'study', label: 'Study' });
    await ended(recording);
    expect(engine.inputs).toEqual([{ app: 'dynamic' }]);
    expect(engine.models).toEqual([served]);
    expect(engine.models[0]).toBe(served);
    expect(source.mock.calls.length).toBe(opens);
    expect(recording.model).toBe(model);
    expect(recording).toMatchObject({
      id: 'study',
      label: 'Study',
      span: [0, 1],
      expectedFrames: 2,
    });
    expect(recording.state).toEqual({
      status: 'complete',
      ahead: 0,
      frameCount: 1,
      timeRange: [0.5, 0.5],
      error: null,
    });
    expect(recording.log).toEqual([{ level: 'warn', message: 'step halved' }]);
    expect([...recording.series('bus')!.state.ranges!]).toEqual([1, 2]);
  });

  it('lends any other model by its source, which the engine reads only as it asks', async () => {
    const [server, client] = loopback();
    const read: string[] = [];
    const local = new Fixture('Local', {
      source: (own) => ({
        ...own,
        class: (id, signal) => {
          read.push(id);
          return own.class(id, signal);
        },
      }),
    });
    const seen: string[] = [];
    const engine = new Scripted(async (recorder, _input, model) => {
      seen.push(new TextDecoder().decode(await model.bytes()));
      seen.push(...(await model.load('bus')).labels);
      recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
    });
    serveEngine(server, engine);
    const recording = (await connectEngine(client)).record(local, null);
    await ended(recording);
    expect(recording.state).toMatchObject({ status: 'complete', frameCount: 1 });
    expect(recording.model).toBe(local);
    expect(seen).toEqual(['Local', 'Bus 1', 'Bus 2']);
    expect(read).toEqual(['bus']);
    expect(engine.models[0]).not.toBe(local);
    expect(engine.models[0]!.name).toBe('Local');
  });

  it('takes back what it lent once the recording ends', async () => {
    const [server, client] = loopback();
    let kept!: Model;
    serveEngine(
      server,
      new Scripted(async (_recorder, _input, model) => {
        kept = model;
      }),
    );
    await ended((await connectEngine(client)).record(fixture(), null));
    await expect(kept.bytes()).rejects.toThrow('the model is no longer lent');
  });

  it('keeps a recording’s frames where the engine runs, a window crossing when read', async () => {
    const [server, client] = loopback();
    const posted: { svc: string; kind: string; body?: object }[] = [];
    const spied = {
      ...server,
      post: (message: unknown, transfer?: readonly ArrayBuffer[]) => {
        posted.push(message as (typeof posted)[number]);
        server.post(message, transfer);
      },
    };
    const store = kept();
    const engine = new Scripted(
      async (recorder) => recorder.append(Float64Array.of(0), { bus: Float32Array.of(3, 4) }),
      { store: () => store },
    );
    serveEngine(spied, engine);
    const remote = await connectEngine(client);
    const input = { edits: Uint8Array.of(1, 2, 3) };
    const recording = remote.record(fixture(), input);
    await ended(recording);
    expect(input.edits.byteLength).toBe(3);
    expect(recording.state.frameCount).toBe(1);
    const changes = posted.filter(({ svc, kind }) => svc === 'engine:record' && kind === 'yield');
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every(({ body }) => !('values' in body!))).toBe(true);
    const block = await recording.series('bus')!.read(0, WINDOW);
    expect([...block.values]).toEqual([3, 4]);
    expect(posted.some(({ svc, kind }) => svc === 'engine:runs' && kind === 'reply')).toBe(true);
    recording.close();
    await vi.waitFor(() => expect(store.closed).toBe(true));
  });

  it('lets each recording go once its peer closes it, and every one with the port', async () => {
    const [server, client] = loopback();
    const stores: ReturnType<typeof kept>[] = [];
    serveEngine(
      server,
      new Scripted(
        async (recorder) =>
          recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() }),
        {
          concurrency: 2,
          store: () => stores[stores.push(kept()) - 1]!,
        },
      ),
    );
    const remote = await connectEngine(client);
    const [first, second] = [remote.record(fixture(), null), remote.record(fixture(), null)];
    await Promise.all([ended(first), ended(second)]);
    const runs = connect(client, protocol<unknown, unknown>('engine:runs'));
    await expect(
      runs.call({ op: 'read', run: 9, classId: 'bus', signalIndex: 0, window: WINDOW }),
    ).rejects.toThrow('run 9 was let go');
    first.close();
    await vi.waitFor(() => expect(stores.map((store) => store.closed)).toEqual([true, false]));
    await expect(
      runs.call({ op: 'read', run: 1, classId: 'bus', signalIndex: 0, window: WINDOW }),
    ).rejects.toThrow('run 1 was let go');
    expect([...(await second.series('bus')!.read(0, WINDOW)).values]).toEqual([1, 2]);
    remote.close();
    await vi.waitFor(() => expect(stores.map((store) => store.closed)).toEqual([true, true]));
  });

  it('lends each file its input gives, its bytes crossing only as the engine reads them', async () => {
    const [server, client] = loopback();
    serveEngine(
      server,
      new Scripted(
        async (recorder, input) => {
          const file = (input as Engine.Input).values['results'] as Engine.File;
          const middle = new TextDecoder().decode(await file.slice(1, 3).arrayBuffer());
          recorder.log('info', `${file.name} ${file.size}: ${await textOf(file)} ${middle}`);
        },
        { studies: [IMPORT] },
      ),
    );
    const remote = await connectEngine(client);
    const file = new File(['abcd'], 'run.arrow');
    const sliced = vi.spyOn(file, 'slice');
    const recording = remote.record(fixture(), { study: 'import', values: { results: file } });
    await ended(recording);
    expect(recording.state.error).toBeNull();
    expect(recording.log).toEqual([{ level: 'info', message: 'run.arrow 4: abcd bc' }]);
    expect(sliced.mock.calls).toEqual([
      [1, 3],
      [0, 4],
    ]);
  });

  it('preserves browser file slice semantics across a port', async () => {
    const [server, client] = loopback();
    const bounds = [
      [-2, 4],
      [0, -1],
      [1.8, 3.9],
      [NaN, Infinity],
      [-Infinity, 2],
      [3, 1],
    ];
    const file = new File(['abcd'], 'run.arrow');
    const expected = await Promise.all(
      bounds.map(async ([start, end]) =>
        new TextDecoder().decode(await file.slice(start!, end!).arrayBuffer()),
      ),
    );
    serveEngine(
      server,
      new Scripted(
        async (recorder, input) => {
          const remoteFile = (input as Engine.Input).values['results'] as Engine.File;
          for (const [start, end] of bounds)
            recorder.log(
              'info',
              new TextDecoder().decode(await remoteFile.slice(start!, end!).arrayBuffer()),
            );
        },
        { studies: [IMPORT] },
      ),
    );
    const remote = await connectEngine(client);
    const recording = remote.record(fixture(), { study: 'import', values: { results: file } });
    await ended(recording);
    expect(recording.state.error).toBeNull();
    expect(recording.log.map(({ message }) => message)).toEqual(expected);
    recording.close();
    remote.close();
  });

  it('fails a recording with why the served engine refused its input or failed', async () => {
    const [server, client] = loopback();
    serveEngine(
      server,
      new Scripted(
        async (recorder) => {
          recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
          throw new Error('engine crashed');
        },
        {
          parse: (input) => {
            if (input !== 'good') throw new TypeError('the engine takes only good input');
            return input;
          },
        },
      ),
    );
    const remote = await connectEngine(client);
    const refused = remote.record(fixture(), 'bad');
    await ended(refused);
    expect(refused.state).toMatchObject({
      status: 'failed',
      error: 'the engine takes only good input',
    });
    const crashed = remote.record(fixture(), 'good');
    await ended(crashed);
    expect(crashed.state).toMatchObject({
      status: 'failed',
      error: 'engine crashed',
      frameCount: 1,
    });
  });

  it('stops the served engine when the far recording stops, keeping what arrived', async () => {
    const [server, client] = loopback();
    let aborted = false;
    serveEngine(
      server,
      new Scripted(async (recorder) => {
        recorder.append(FRAMES.time.slice(), { bus: FRAMES.values.bus.slice() });
        await new Promise<void>((resolve) =>
          recorder.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        aborted = true;
        recorder.signal.throwIfAborted();
      }),
    );
    const recording = (await connectEngine(client)).record(fixture(), null);
    await vi.waitFor(() => expect(recording.state.frameCount).toBe(1));
    recording.stop();
    expect(recording.state.status).toBe('stopped');
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(recording.state).toMatchObject({ status: 'stopped', frameCount: 1 });
  });

  it('queues what the served engine cannot take at once, and each learns its place', async () => {
    const [server, client] = loopback();
    const finish: (() => void)[] = [];
    serveEngine(server, new Scripted(() => new Promise<void>((resolve) => finish.push(resolve))));
    const remote = await connectEngine(client);
    const first = remote.record(fixture(), 1);
    const second = remote.record(fixture(), 2);
    await vi.waitFor(() => expect(first.state.status).toBe('recording'));
    await vi.waitFor(() => expect(second.state).toMatchObject({ status: 'waiting', ahead: 0 }));
    finish.shift()!();
    await ended(first);
    await vi.waitFor(() => expect(second.state.status).toBe('recording'));
    finish.shift()!();
    await ended(second);
    expect(second.state.status).toBe('complete');
  });

  it('sends a slow peer what changed since it last caught up, whatever the engine did between', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    let blocked = true;
    serveEngine(
      {
        ...server,
        drain: () =>
          blocked ? new Promise<void>((resolve) => (release = () => resolve())) : Promise.resolve(),
      },
      new Scripted(async (recorder: Engine.Recorder) => {
        for (let i = 0; i < 40; i++) recorder.log('info', String(i));
        await settle();
        blocked = false;
        release();
      }),
    );
    const recording = (await connectEngine(client)).record(fixture(), null);
    await ended(recording);
    expect(recording.log.map(({ message }) => message)).toEqual(
      Array.from({ length: 40 }, (_, i) => String(i)),
    );
  });

  it('serves an engine that is still opening, and refuses a connection to one that cannot', async () => {
    const [server, client] = loopback();
    let release!: (engine: Scripted) => void;
    serveEngine(server, new Promise<Scripted>((resolve) => (release = resolve)));
    const connecting = connectEngine(client);
    await settle();
    release(new Scripted(async (recorder) => recorder.log('info', 'late')));
    const recording = (await connecting).record(fixture(), null);
    await ended(recording);
    expect(recording.log).toEqual([{ level: 'info', message: 'late' }]);

    const [failing, failed] = loopback();
    serveEngine(failing, Promise.reject(new Error('no solver')));
    await expect(connectEngine(failed)).rejects.toThrow('no solver');
  });

  it('refuses a request its check refuses, saying why', async () => {
    const [server, client] = loopback();
    serveEngine(server, new Scripted(async () => {}));
    const raw = connect(client, protocol<unknown, unknown>('engine:record'));
    const stream = (request: unknown) => raw.stream(request)[Symbol.asyncIterator]().next();
    await expect(stream({ input: 1, lent: 1 })).rejects.toThrow(
      'engine:record request.run must be a nonnegative safe integer',
    );
    await expect(stream({ run: 1, input: 1 })).rejects.toThrow(
      'engine:record request.lent must be a nonnegative safe integer',
    );
    await expect(stream({ run: 1, input: 1, lent: 1, home: 5 })).rejects.toThrow(
      'engine:record request.home must be a string',
    );
    await expect(stream('record')).rejects.toThrow('engine:record request must be an object');
    const runs = connect(client, protocol<unknown, unknown>('engine:runs'));
    await expect(runs.call({ op: 'read', run: 1, classId: 'bus', signalIndex: 0 })).rejects.toThrow(
      'engine:runs request.window must be an object',
    );
    await expect(runs.call({ op: 'release', run: 1 })).resolves.toBeUndefined();
    const asks = connect(client, protocol<unknown, unknown>('engine:studies'));
    await expect(asks.call({ op: 'list' })).rejects.toThrow(
      'engine:studies request.op must be one of studies, read',
    );
    await expect(asks.call({ op: 'read', file: { name: 'a' }, lent: 1 })).rejects.toThrow(
      'engine:studies request.file.lent must be a nonnegative safe integer',
    );
    await expect(
      asks.call({ op: 'read', file: { lent: 2, name: 'a', size: 1 }, lent: 1 }),
    ).rejects.toThrow('the served engine reads no files');
  });

  it('ends when either side closes', async () => {
    const [server, client] = loopback();
    const onClose = vi.fn();
    serveEngine(server, new Scripted(async () => {}), { onClose });
    const remote = await connectEngine(client);
    remote.close();
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
    const recording = remote.record(fixture(), null);
    await ended(recording);
    expect(recording.state).toMatchObject({
      status: 'failed',
      error: 'The connection was closed.',
    });

    const [otherServer, otherClient] = loopback();
    const stop = serveEngine(otherServer, new Scripted(() => new Promise<void>(() => {})));
    const waiting = (await connectEngine(otherClient)).record(fixture(), null);
    await vi.waitFor(() => expect(waiting.state.status).toBe('recording'));
    stop();
    await ended(waiting);
    expect(waiting.state).toMatchObject({ status: 'failed', error: 'The service was closed.' });
  });

  it('offers what the served engine offers, checking a form here before anything crosses', async () => {
    const [server, client] = loopback();
    const engine = new Scripted(async () => {}, { studies: [SIMULATION] });
    serveEngine(server, engine);
    const posted: unknown[] = [];
    const remote = await connectEngine({
      ...client,
      post: (message: unknown, transfer?: readonly ArrayBuffer[]) => {
        posted.push(message);
        client.post(message, transfer);
      },
    });
    expect(remote.studies).toEqual(engine.studies);
    const model = fixture();
    const input = (values: Engine.Values): Engine.Input => ({ study: 'simulation', values });
    expect(remote.shown(input({ fault: true })).map((parameter) => parameter.id)).toEqual([
      'tmax',
      'bus',
    ]);
    expect(remote.problems(model, input({ tmax: 0 }))).toEqual({
      tmax: 'End time must be greater than 0.',
    });
    const crossed = posted.length;
    expect(() => remote.record(model, input({ tmax: 0 }))).toThrow(Refusal);
    expect(posted).toHaveLength(crossed);

    const bus = { classId: 'bus', index: 1 };
    const recording = remote.record(model, input({ tmax: 5, fault: true, bus }));
    await ended(recording);
    expect(recording.state.status).toBe('complete');
    expect(recording.label).toBe('Simulation');
    expect(engine.inputs).toEqual([
      { study: 'simulation', values: { fault: true, tmax: 5, bus: { classId: 'bus', index: 1 } } },
    ]);
  });

  it('follows each study its peer offers or withdraws, in order, keeping one that did not change', async () => {
    const [server, client] = loopback();
    const engine = new Scripted(async () => {}, { studies: [SIMULATION] });
    serveEngine(server, engine);
    const remote = await connectEngine(client);
    const heard = vi.fn();
    remote.on('change', heard);
    const [kept] = remote.studies;
    const withdraw = engine.offer(SWEEP);
    await vi.waitFor(() =>
      expect(remote.studies.map((study) => study.id)).toEqual(['simulation', 'sweep']),
    );
    expect(remote.studies[0]).toBe(kept);
    engine.offer({ ...SIMULATION, label: 'Transient' });
    await vi.waitFor(() => expect(remote.studies[0]!.label).toBe('Transient'));
    withdraw();
    await vi.waitFor(() => expect(remote.studies.map((study) => study.id)).toEqual(['simulation']));
    expect(heard).toHaveBeenCalledTimes(3);
    expect(() => remote.record(fixture(), { study: 'sweep', values: {} })).toThrow(
      "No study 'sweep' is offered.",
    );
  });

  it('orders a change that overtakes the first offer by its revision', async () => {
    const [server, client] = loopback();
    const service = serve(server, protocol<unknown, unknown, unknown>('engine:studies'), () => {
      service.emit({ revision: 2, studies: [SIMULATION, SWEEP], reads: false });
      return Promise.resolve({ revision: 1, studies: [SIMULATION], reads: false });
    });
    const remote = await connectEngine(client);
    expect(remote.studies.map((study) => study.id)).toEqual(['simulation', 'sweep']);
  });

  it('refuses a connection to an engine that offers a study that is not well formed', async () => {
    const [server, client] = loopback();
    serve(server, protocol<unknown, unknown>('engine:studies'), () =>
      Promise.resolve({
        revision: 0,
        studies: [{ id: 's', label: 'S', parameters: [{ id: 'a', kind: 'date', label: 'A' }] }],
        reads: false,
      }),
    );
    await expect(connectEngine(client)).rejects.toThrow("study 's' parameter 'a' is malformed");
  });

  it('reads a saved file with the served engine, lending the model it reads against', async () => {
    const [server, client] = loopback();
    const reader = new Reader(async () => {}, { studies: [SIMULATION] });
    serveEngine(server, reader);
    const remote = await connectEngine(client);
    expect(await remote.read!(fixture('Local'), new File(['7'], 'saved.json'))).toEqual({
      study: 'simulation',
      values: { tmax: 7 },
    });
    expect(reader.files).toEqual(['Local: saved.json']);

    const [plainServer, plainClient] = loopback();
    serveEngine(plainServer, new Scripted(async () => {}));
    expect((await connectEngine(plainClient)).read).toBeUndefined();
  });
});
