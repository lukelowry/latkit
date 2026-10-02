import { kit } from '@latkit/gpu';
import { describe, expect, it, vi } from 'vitest';
import { destination } from '../src/output.js';
import type { VideoWrite } from '../src/video.js';
describe('borrowed destination', () => {
  it('preserves positional writes, byte extent and caller-owned lifetime', async () => {
    const writes: VideoWrite[] = [],
      close = vi.fn(),
      abort = vi.fn();
    const output = new WritableStream<VideoWrite>({
      write: (chunk) => {
        writes.push(chunk);
      },
      close,
      abort,
    });
    const sink = destination(output, new kit.Work(new AbortController().signal)),
      writer = sink.stream.getWriter();
    const data = Uint8Array.of(1, 2, 3);
    await writer.write({ type: 'write', position: 100, data });
    data.fill(9);
    await writer.write({ type: 'write', position: 0, data: Uint8Array.of(4) });
    await writer.close();
    writer.releaseLock();
    sink.release();
    expect(sink.byteLength).toBe(103);
    expect([...writes[0].bytes]).toEqual([1, 2, 3]);
    expect(output.locked).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });
  it('cancels a stalled write without aborting the caller stream', async () => {
    let resolve!: () => void;
    const abort = vi.fn();
    const output = new WritableStream<VideoWrite>({
      write: () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
      abort,
    });
    const stop = new AbortController(),
      sink = destination(output, new kit.Work(stop.signal)),
      writer = sink.stream.getWriter();
    const write = writer.write({ type: 'write', position: 0, data: Uint8Array.of(1) });
    await new Promise((r) => setTimeout(r, 0));
    stop.abort(new Error('stopped'));
    await expect(write).rejects.toThrow('stopped');
    sink.release();
    expect(output.locked).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    resolve();
    await writer.closed.catch(() => {});
    writer.releaseLock();
  });
  it('propagates write failures', async () => {
    const output = new WritableStream<VideoWrite>({
      write() {
        throw new Error('disk full');
      },
    });
    const sink = destination(output, new kit.Work(new AbortController().signal)),
      writer = sink.stream.getWriter();
    await expect(
      writer.write({ type: 'write', position: 0, data: Uint8Array.of(1) }),
    ).rejects.toThrow('disk full');
    sink.release();
    await writer.closed.catch(() => {});
    writer.releaseLock();
  });
});
