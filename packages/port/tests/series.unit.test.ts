import { describe, expect, it, vi } from 'vitest';
import { Series } from '@latkit/model';
import { connectSeries, serveSeries, loopback } from '../src/index.js';
function fixture() {
  const series = Series.create({ signals: ['value'], elementCount: 3 });
  series.append({ time: new Float64Array([0, 1]), values: new Float32Array([1, 2, 3, 4, 5, 6]) });
  return series;
}
const window = { frameOffset: 0, frameCount: 2, elementOffset: 1, elementCount: 1 };
describe('series service', () => {
  it('pins history, compacts strided reads, and leaves borrowed source buffers intact', async () => {
    const source = fixture();
    const [server, client] = loopback();
    const stop = serveSeries(server, source, { snapshot: true });
    source.append({ time: new Float64Array([2]), values: new Float32Array([7, 8, 9]) });
    const remote = await connectSeries(client);
    try {
      expect(remote.state.frameCount).toBe(2);
      expect(remote.state.live).toBe(false);
      expect(await remote.locate([0, 2], 2)).toEqual([0, 2]);
      const block = await remote.read(0, window);
      expect([...block.values]).toEqual([2, 5]);
      expect(block.stride).toBe(1);
      block.values.fill(0);
      expect((await source.read(0, window)).values[0]).toBe(2);
      await expect(remote.read(0, { ...window, frameCount: 3 })).rejects.toThrow();
      await expect(remote.locate([0, 3], 3)).rejects.toThrow('committed');
    } finally {
      remote.close();
      stop();
    }
  });
  it('follows appends and sealing without copying samples up front', async () => {
    const source = fixture(),
      read = vi.spyOn(source, 'read');
    const [server, client] = loopback();
    const stop = serveSeries(server, source);
    const remote = await connectSeries(client);
    source.append({ time: new Float64Array([2]), values: new Float32Array([7, 8, 9]) });
    source.seal();
    await vi.waitFor(() => expect(remote.state).toMatchObject({ frameCount: 3, live: false }));
    expect(read).not.toHaveBeenCalled();
    remote.close();
    stop();
  });
  it('propagates cancellation into a pending source read', async () => {
    const source = fixture();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    vi.spyOn(source, 'read').mockImplementation(
      (_index, _window, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal!.addEventListener(
            'abort',
            () => {
              cancelled = true;
              reject(new DOMException('Read cancelled', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const [server, client] = loopback();
    const stop = serveSeries(server, source);
    const remote = await connectSeries(client);
    const abort = new AbortController();
    const pending = remote.read(0, window, abort.signal);
    await entered;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cancelled).toBe(true));
    remote.close();
    stop();
  });
});
