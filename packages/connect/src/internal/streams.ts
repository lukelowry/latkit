import { failure } from './errors.js';
export function bytes(
  stream: ReadableStream<Uint8Array>,
  size: number,
): AsyncIterableIterator<Uint8Array> {
  if (stream.locked) throw failure('invalid-input', 'Content stream is already in use.');
  const reader = stream.getReader();
  let chunk: Uint8Array | undefined;
  let offset = 0;
  let ended = false;
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (ended) return { done: true, value: undefined };
      while (!chunk || offset >= chunk.length) {
        const result = await reader.read();
        if (result.done || ended) {
          ended = true;
          release();
          return { done: true, value: undefined };
        }
        if (!(result.value instanceof Uint8Array))
          throw failure('invalid-input', 'Expected byte chunk.');
        chunk = result.value;
        offset = 0;
      }
      const value = chunk.subarray(offset, offset + size);
      offset += value.length;
      return { done: false, value };
    },
    async return() {
      if (!ended) {
        ended = true;
        try {
          await reader.cancel();
        } finally {
          release();
        }
      }
      return { done: true, value: undefined };
    },
  };
}
export function readable(iterator: AsyncIterableIterator<unknown>): ReadableStream<Uint8Array> {
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          if (!(next.value instanceof Uint8Array))
            throw failure('invalid-input', 'Expected byte chunk.');
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}
