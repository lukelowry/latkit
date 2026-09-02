import { describe, expect, it, vi } from 'vitest';

import { collect, type Results, type RunFrames } from '@latkit/model';
import { connect, protocol } from '@latkit/port';
import { loopback, settle } from '@latkit/port/testing';

import { connectResults, serveResults } from '../src/index.js';

/** Two signals over two elements across three frames, frame-major as a run streams them. */
const BUS: RunFrames = {
  classId: 'bus',
  elementCount: 2,
  signalCount: 2,
  time: Float64Array.of(0, 0.5, 1),
  values: Float32Array.of(1, 2, 10, 20, 3, 4, 30, 40, 5, 6, 50, 60),
};

/** In-memory results over one class: `rows` frames per batch, restricted to the selection. */
function memory(recorded: RunFrames, rows = 1): Results {
  return {
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
    const remote = connectResults(client);
    const series = await collect(remote.read('bus', null), 3);
    expect(series.signalCount).toBe(2);
    expect(Array.from(series.time)).toEqual([0, 0.5, 1]);
    expect(Array.from(series.values)).toEqual([1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 50, 60]);
    expect(Array.from(series.ranges)).toEqual([1, 6, 10, 60]);
  });

  it('a selection restricts and orders the signals', async () => {
    const [server, client] = loopback();
    serveResults(server, memory(BUS));
    const remote = connectResults(client);
    const one = await collect(remote.read('bus', [1]), 3);
    expect(one.signalCount).toBe(1);
    expect(Array.from(one.values)).toEqual([10, 20, 30, 40, 50, 60]);
    const swapped = await collect(remote.read('bus', [1, 0]));
    expect(Array.from(swapped.values)).toEqual([10, 20, 30, 40, 50, 60, 1, 2, 3, 4, 5, 6]);
  });

  it('awaits the port drain between batches so backpressure reaches the wire', async () => {
    const [server, client] = loopback();
    const drainPort = vi.fn(async () => {});
    serveResults({ ...server, drain: drainPort }, memory(BUS));
    expect((await drain(connectResults(client).read('bus', null))).length).toBe(3);
    expect(drainPort).toHaveBeenCalledTimes(3);
  });

  it('aborting a read stops the serving side and ends the iteration quietly', async () => {
    const [server, client] = loopback();
    let aborted = false;
    serveResults(server, {
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
    for await (const batch of connectResults(client).read('bus', null, controller.signal)) {
      batches.push(batch);
      controller.abort();
    }
    expect(batches).toHaveLength(1);
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('a read failure rejects that read and the service keeps serving', async () => {
    const [server, client] = loopback();
    serveResults(server, memory(BUS));
    const remote = connectResults(client);
    await expect(collect(remote.read('gen', null))).rejects.toThrow('no gen recorded');
    await expect(collect(remote.read('bus', [2]))).rejects.toThrow(/out of range/);
    expect((await collect(remote.read('bus', [0]), 3)).signalCount).toBe(1);
  });

  it('bounds a selection only when the served side asks', async () => {
    const [server, client] = loopback();
    const stop = serveResults(server, memory(BUS));
    const wide = Array.from({ length: 5000 }, (_, i) => i % 2);
    expect((await collect(connectResults(client).read('bus', wide), 3)).signalCount).toBe(5000);
    stop();

    const [boundedServer, boundedClient] = loopback();
    serveResults(boundedServer, memory(BUS), { maxSignals: 1 });
    const remote = connectResults(boundedClient);
    await expect(collect(remote.read('bus', [0, 1]))).rejects.toThrow(/malformed results request/);
    expect((await collect(remote.read('bus', [1]), 3)).signalCount).toBe(1);
  });

  it('rejects a malformed request without ending the service', async () => {
    const [server, client] = loopback();
    serveResults(server, memory(BUS));
    const raw = connect(client, protocol<unknown, unknown>('results'));
    for (const request of [
      { classId: 1, signals: null },
      { classId: 'bus' },
      { classId: 'bus', signals: [-1] },
      { classId: 'bus', signals: [0.5] },
      'bus',
    ]) {
      await expect(drain(raw.stream(request))).rejects.toThrow(/malformed results request/);
    }
    expect(await drain(raw.stream({ classId: 'bus', signals: [0] }))).toHaveLength(3);
  });

  it('closing either side ends the reads', async () => {
    const [server, client] = loopback();
    let release!: () => void;
    const stop = serveResults(server, {
      async *read() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield BUS;
      },
    });
    const remote = connectResults(client);
    const pending = drain(remote.read('bus', null));
    await settle();
    stop();
    await expect(pending).rejects.toThrow(/service was closed/);
    release();

    const [otherServer, otherClient] = loopback();
    serveResults(otherServer, memory(BUS));
    const other = connectResults(otherClient);
    other.close();
    await expect(drain(other.read('bus', null))).rejects.toThrow(/connection was closed/);
  });
});
