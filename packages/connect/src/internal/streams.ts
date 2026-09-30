import type { WritePart } from '@latkit/model';
import { failure } from './errors.js';
import { record, integer } from './validation.js';
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
export async function* parts(
  source: AsyncIterable<WritePart>,
  size: number,
): AsyncGenerator<WritePart> {
  for await (const part of checkedParts(source)) {
    if (part.kind === 'copy') {
      yield part;
      continue;
    }
    for (let offset = 0; offset < part.bytes.length; offset += size)
      yield { kind: 'data', bytes: part.bytes.subarray(offset, offset + size) };
  }
}
export async function* checkedParts(source: AsyncIterable<unknown>): AsyncGenerator<WritePart> {
  for await (const value of source) {
    const part = record(value);
    if (part.kind === 'data' && part.bytes instanceof Uint8Array)
      yield { kind: 'data', bytes: part.bytes };
    else if (part.kind === 'copy' && integer(part.offset) && integer(part.length))
      yield { kind: 'copy', offset: part.offset, length: part.length };
    else throw failure('invalid-input', 'Invalid write part.');
  }
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
