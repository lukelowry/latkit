import type { Gpu } from '../gpu.js';
import type { BufferResource } from './buffers.js';

/** Staging buffers a feedback holds at most: a frame in flight, one mapping, and one to spare. */
const RING = 3;

/**
 * Words the GPU writes during a frame, read back without stalling one: each frame copies them into
 * a staging buffer of a small ring, mapped once the frame's commands complete. Each copy's words
 * reach `read` with what the frame said they mean, a frame or two late; a frame finding every
 * staging buffer still mapping copies none, and the next one reports.
 */
export class Feedback<Context> {
  private readonly free: BufferResource[] = [];
  private pending: {
    readonly staging: BufferResource;
    readonly bytes: number;
    readonly context: Context;
  }[] = [];
  private made = 0;
  private closed = false;
  constructor(
    private readonly gpu: Gpu,
    private readonly read: (words: Uint32Array, context: Context) => void,
    private readonly label: string,
  ) {}
  /** Copy the first `bytes` of `source` as the frame's commands record, to read back once they complete. */
  encode(encoder: GPUCommandEncoder, source: GPUBuffer, bytes: number, context: Context): void {
    const size = Math.max(16, Math.ceil(bytes / 16) * 16);
    let staging = this.free.pop();
    if (staging && staging.buffer.size < size) {
      staging.destroy();
      this.made--;
      staging = undefined;
    }
    if (!staging) {
      if (this.made >= RING) return;
      staging = this.gpu.buffer({
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        label: this.label,
      });
      this.made++;
    }
    encoder.copyBufferToBuffer(source, 0, staging.buffer, 0, Math.ceil(bytes / 4) * 4);
    this.pending.push({ staging, bytes, context });
  }
  /** The frame was submitted: map what it copied, and hand each copy's words to `read`. */
  submitted(): void {
    for (const { staging, bytes, context } of this.pending.splice(0))
      staging.buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          if (!this.closed) {
            const words = new Uint32Array(
              staging.buffer.getMappedRange(0, Math.ceil(bytes / 4) * 4).slice(0),
            );
            staging.buffer.unmap();
            this.free.push(staging);
            this.read(words, context);
          } else staging.destroy();
        },
        // A lost device, or a destroyed Gpu, ends the feedback with it.
        () => staging.destroy(),
      );
  }
  /** The frame was discarded: what it copied is never read, and its staging buffers are free again. */
  discard(): void {
    for (const { staging } of this.pending.splice(0)) this.free.push(staging);
  }
  destroy(): void {
    this.closed = true;
    for (const staging of this.free.splice(0)) staging.destroy();
    this.discard();
    for (const staging of this.free.splice(0)) staging.destroy();
  }
}
