import { Work } from '@latkit/model';
import type { StreamTargetChunk } from 'mediabunny';
import type { VideoWrite } from './video.js';
/** Private muxer stream owns neither the application's destination nor its close/abort policy. */
export function destination(output: WritableStream<VideoWrite>, work: Work) {
  const writer = output.getWriter();
  let byteLength = 0;
  const stream = new WritableStream<StreamTargetChunk>(
    {
      async write(chunk) {
        work.signal.throwIfAborted();
        // Encoded bytes are small relative to raw frames. An independent slice also survives cancellation
        // while a caller-owned write is still pending; no raw image or model data is copied here.
        const bytes = chunk.data.slice();
        await work.wait(writer.write({ position: chunk.position, bytes }));
        byteLength = Math.max(byteLength, chunk.position + bytes.byteLength);
      },
    },
    { highWaterMark: 1 },
  );
  return {
    stream,
    get byteLength() {
      return byteLength;
    },
    release() {
      writer.releaseLock();
    },
  };
}
