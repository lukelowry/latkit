import { describe, expect, it, vi } from 'vitest';

import { collect, createSeries, type Series, type Results, type RunFrames } from '@latkit/model';
import { connect, protocol } from '@latkit/port';
import { loopback, settle } from '@latkit/port/testing';

import { connectResults, serveResults } from '../src/index.js';

/** Two signals over two elements across three frames, frame-major as a run streams them. */
const BUS: RunFrames = {
  resultId: 'run',
  classId: 'bus',
  elementCount: 2,
  signalCount: 2,
  time: Float64Array.of(0, 0.5, 1),
  values: Float32Array.of(1, 2, 10, 20, 3, 4, 30, 40, 5, 6, 50, 60),
};

/** In-memory results over one class: `rows` frames per batch, restricted to the selection. */
function memory(recorded: RunFrames, rows = 1): Results {
  return {
    id: recorded.resultId,
    async series(classId) {
      if (classId !== recorded.classId) throw new Error('no ' + classId + ' recorded');
      return collect([recorded]);
    },
    async *read(classId, signals, signal) {
      if (classId !== recorded.classId) throw new Error(`no ${classId} recorded`);
      const picked = signals ?? Array.from({ length: recorded.signalCount }, (_, i) => i);
      for (const s of picked) {
        if (s >= recorded.signalCount) throw new RangeError(`signal ${s} out of range`);
      }
      const { elementCount } = recorded;
      for (let from = 0; from < recorded.time.length; from += rows) {
        signal?.throwIfAborted();
        const count = Math.min(rows, recorded.time.length - from);
        const values = new Float32Array(count * picked.length * elementCount);
        for (let row = 0; row < count; row++) {
          picked.forEach((s, at) => {
            const start = ((from + row) * recorded.signalCount + s) * elementCount;
            values.set(
              recorded.values.subarray(start, start + elementCount),
              (row * picked.length + at) * elementCount,
            );
          });
        }
        yield {
          classId,
          resultId: recorded.resultId,
          elementCount,
          signalCount: picked.length,
          time: recorded.time.slice(from, from + count),
          values,
        };
      }
    },
  };
}

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe('results service', () => {
  it('streams one class in order and collects it into a series', async () => {
    const [server, client] = loopback();
    serveResults(server, memory(BUS));
    const remote = connectResults(client, 'run');
    const series = await collect(remote.read('bus', null), 3);
    expect(series.signalCount).toBe(2);
    expect(
      Array.from(
        (await series.read(0, { frameOffset: 0, frameCount: 3, elementOffset: 0, elementCount: 2 }))
          .time,
      ),
    ).toEqual([0, 0.5, 1]);
    expect(await valuesOf(series)).toEqual([1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 50, 60]);
    expect(Array.from(series.state.ranges!)).toEqual([1, 6, 10, 60]);
  });

  it('a selection restricts and orders the signals', async () => {
    const [server, client] = loopback();
    serveResults(server, memory(BUS));
    const remote = connectResults(client, 'run');
    const one = await collect(remote.read('bus', [1]), 3);
    expect(one.signalCount).toBe(1);
    expect(await valuesOf(one)).toEqual([10, 20, 30, 40, 50, 60]);
    const swapped = await collect(remote.read('bus', [1, 0]));
    expect(await valuesOf(swapped)).toEqual([10, 20, 30, 40, 50, 60, 1, 2, 3, 4, 5, 6]);
  });

  it('awaits the port drain between batches so backpressure reaches the wire', async () => {
    const [server, client] = loopback();
    const drainPort = vi.fn(async () => {});
    serveResults({ ...server, drain: drainPort }, memory(BUS));
    expect((await drain(connectResults(client, 'run').read('bus', null))).length).toBe(3);
    expect(drainPort).toHaveBeenCalledTimes(3);
  });

  it('aborting a read stops the serving side and ends the iteration quietly', async () => {
    const [server, client] = loopback();
    let aborted = false;
    serveResults(server, {
      ...memory(BUS),
      async *read(_classId, _signals, signal) {
        yield { ...BUS, time: Float64Array.of(0), values: BUS.values.slice(0, 4) };
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        aborted = true;
      },
    });
    const controller = new AbortController();
    const batches: RunFrames[] = [];
    for await (const batch of connectResults(client, 'run').read('bus', null, controller.signal)) {
      batches.push(batch);
      controller.abort();
    }
    expect(batches).toHaveLength(1);
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('a read failure rejects that read and the service keeps serving', async () => {
    const [server, client] = loopback();
    serveResults(server, memory(BUS));
    const remote = connectResults(client, 'run');
    await expect(collect(remote.read('gen', null))).rejects.toThrow('no gen recorded');
    await expect(collect(remote.read('bus', [2]))).rejects.toThrow(/out of range/);
    expect((await collect(remote.read('bus', [0]), 3)).signalCount).toBe(1);
  });

  it('bounds a selection only when the served side asks', async () => {
    const [server, client] = loopback();
    const stop = serveResults(server, memory(BUS));
    const wide = Array.from({ length: 5000 }, (_, i) => i % 2);
    expect((await collect(connectResults(client, 'run').read('bus', wide), 3)).signalCount).toBe(
      5000,
    );
    stop();

    const [boundedServer, boundedClient] = loopback();
    serveResults(boundedServer, memory(BUS), { maxSignals: 1 });
    const remote = connectResults(boundedClient, 'run');
    await expect(collect(remote.read('bus', [0, 1]))).rejects.toThrow(
      /malformed results:run request/,
    );
    expect((await collect(remote.read('bus', [1]), 3)).signalCount).toBe(1);
  });

  it('rejects a malformed request without ending the service', async () => {
    const [server, client] = loopback();
    serveResults(server, memory(BUS));
    const raw = connect(client, protocol<unknown, unknown>('results:run'));
    for (const request of [
      { classId: 1, signals: null },
      { classId: 'bus' },
      { classId: 'bus', signals: [-1] },
      { classId: 'bus', signals: [0.5] },
      'bus',
    ]) {
      await expect(drain(raw.stream(request))).rejects.toThrow(/malformed results:run request/);
    }
    expect(await drain(raw.stream({ op: 'read', classId: 'bus', signals: [0] }))).toHaveLength(3);
  });

  it('closing either side ends the reads', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    const stop = serveResults(server, {
      ...memory(BUS),
      async *read() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield BUS;
      },
    });
    const remote = connectResults(client, 'run');
    const pending = drain(remote.read('bus', null));
    await settle();
    stop();
    await expect(pending).rejects.toThrow(/service was closed/);
    release();

    const [otherServer, otherClient] = loopback();
    serveResults(otherServer, memory(BUS));
    const other = connectResults(otherClient, 'run');
    other.close();
    await expect(drain(other.read('bus', null))).rejects.toThrow(/connection was closed/);
  });
});

async function valuesOf(series: Series): Promise<number[]> {
  const values: number[] = [];
  for (let s = 0; s < series.signalCount; s++) {
    const block = await series.read(s, {
      frameOffset: 0,
      frameCount: series.state.frameCount,
      elementOffset: 0,
      elementCount: series.elementCount,
    });
    for (let f = 0; f < block.time.length; f++)
      values.push(
        ...block.values.subarray(f * block.stride, f * block.stride + series.elementCount),
      );
  }
  return values;
}

it('reads strided Float64 samples without transferring retained producer buffers', async () => {
  const [server, client] = loopback();
  const input = { ...BUS, values: Float64Array.from(BUS.values, (value) => 1e12 + value / 8) };
  const local = createSeries({ elementCount: 2, signalCount: 2 });
  local.append(input);
  const stop = serveResults(server, { ...memory(input), series: async () => local });
  const remote = connectResults(client, 'run');
  const series = await remote.series('bus');
  const block = await series.read(1, {
    frameOffset: 0,
    frameCount: 3,
    elementOffset: 1,
    elementCount: 1,
  });
  expect(block.values).toBeInstanceOf(Float64Array);
  expect([...block.values]).toEqual([1e12 + 20 / 8, 1e12 + 40 / 8, 1e12 + 60 / 8]);
  expect(block.stride).toBe(1);
  expect(block.values.buffer).not.toBe(input.values.buffer);
  expect(input.values.byteLength).toBe(96);
  expect(await series.locate([0.5, 0.5], 3)).toEqual([1, 2]);
  remote.close();
  stop();
});

it('publishes appends atomically and keeps one subscription per class', async () => {
  const [server, client] = loopback();
  const local = createSeries({ elementCount: 2, signalCount: 2 });
  local.append(BUS);
  const subscribe = vi.fn(local.on);
  const unsubscribe = vi.fn();
  const stop = serveResults(server, {
    ...memory(BUS),
    series: async () => ({
      ...local,
      get state() {
        return local.state;
      },
      on: (event, listener) => {
        const off = subscribe(event, listener);
        return () => {
          off();
          unsubscribe();
        };
      },
    }),
  });
  const remote = connectResults(client, 'run');
  const [first, second] = await Promise.all([remote.series('bus'), remote.series('bus')]);
  expect(first).toBe(second);
  expect(subscribe).toHaveBeenCalledOnce();
  const old = first.state,
    appended = vi.fn();
  first.on('append', appended);
  local.append({
    ...BUS,
    time: Float64Array.of(1, 2),
    values: Float32Array.of(7, 8, 70, 80, 9, 10, 90, 100),
  });
  await vi.waitFor(() => expect(first.state.frameCount).toBe(5));
  expect(old.frameCount).toBe(3);
  expect(first.state.timeRange).toEqual([0, 2]);
  expect(appended).toHaveBeenCalledOnce();
  expect(await first.locate([1, 1], 3)).toEqual([2, 3]);
  expect(await first.locate([1, 1], 5)).toEqual([2, 4]);
  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
  remote.close();
});

it('rejects oversized and out-of-bounds sample requests before reading the producer', async () => {
  const [server, client] = loopback();
  const local = collect([BUS]),
    read = vi.fn(local.read);
  const stop = serveResults(
    server,
    { ...memory(BUS), series: async () => ({ ...local, read }) },
    { maxBytes: 16 },
  );
  const remote = connectResults(client, 'run');
  const series = await remote.series('bus');
  await expect(
    series.read(0, { frameOffset: 0, frameCount: 3, elementOffset: 0, elementCount: 2 }),
  ).rejects.toThrow('maxBytes');
  await expect(
    series.read(2, { frameOffset: 0, frameCount: 1, elementOffset: 0, elementCount: 1 }),
  ).rejects.toThrow('committed');
  await expect(
    series.read(0, { frameOffset: 3, frameCount: 1, elementOffset: 0, elementCount: 1 }),
  ).rejects.toThrow('committed');
  expect(read).not.toHaveBeenCalled();
  expect(
    (await series.read(0, { frameOffset: 0, frameCount: 1, elementOffset: 0, elementCount: 1 }))
      .values[0],
  ).toBe(1);
  remote.close();
  stop();
});
