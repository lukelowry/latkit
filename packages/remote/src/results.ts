/**
 * One result served over a port. Series publish append state and answer bounded windows;
 * batch reads retain the runner's original frame-major representation.
 */
import {
  createEmitter,
  validateSeries,
  type Domain,
  type Results,
  type RunFrames,
  type Series,
} from '@latkit/model';
import { connect, type Port, protocol, serve, transferred } from '@latkit/port';
import { arrayOf, finite, index, nullable, object, requests, str } from '@latkit/port/guard';
import type { Remote } from './remote.js';

type Window = Parameters<Series['read']>[1];
type Block = Awaited<ReturnType<Series['read']>>;
type Header = Pick<Series, 'elementCount' | 'signalCount' | 'elements' | 'state'>;
type Request =
  | { op: 'series'; classId: string }
  | { op: 'read'; classId: string; signals: readonly number[] | null }
  | { op: 'samples'; classId: string; signalIndex: number; window: Window }
  | { op: 'locate'; classId: string; range: Domain; frameCount: number };
type Reply =
  | { op: 'series'; header: Header }
  | { op: 'read'; frames: RunFrames }
  | {
      op: 'samples';
      block: {
        time: Float64Array<ArrayBuffer>;
        values: Float32Array<ArrayBuffer> | Float64Array<ArrayBuffer>;
        stride: number;
      };
    }
  | { op: 'locate'; bounds: readonly [number, number] };
type Append = { classId: string; state: Series['state'] };
const isRange = (value: unknown): value is Domain =>
  Array.isArray(value) &&
  value.length === 2 &&
  finite(value[0]) &&
  finite(value[1]) &&
  value[0] <= value[1];
const isWindow = object<Window>({
  frameOffset: index,
  frameCount: index,
  elementOffset: index,
  elementCount: index,
});
const resultsProtocol = (id: string, maxSignals = Infinity) =>
  protocol<Request, Reply, Append>(
    `results:${id}`,
    requests<Request>({
      series: { classId: str },
      read: { classId: str, signals: nullable(arrayOf(index, maxSignals)) },
      samples: { classId: str, signalIndex: index, window: isWindow },
      locate: { classId: str, range: isRange, frameCount: index },
    }),
  );
const copyState = (state: Series['state']): Series['state'] => ({
  frameCount: state.frameCount,
  timeRange: state.timeRange && [...state.timeRange],
  ranges: state.ranges?.slice() ?? null,
});

/** Serve one result. Sample windows are capped at maxBytes (4 MiB by default), including time. */
export function serveResults(
  port: Port,
  results: Results,
  options: { readonly maxSignals?: number; readonly maxBytes?: number } = {},
): () => void {
  if (!results.id) throw new Error('results need an id');
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16)
    throw new RangeError('maxBytes must be an integer of at least 16');
  const opened = new Map<string, { series: Series; off(): void }>();
  let closed = false;
  async function get(classId: string, signal: AbortSignal): Promise<Series> {
    signal.throwIfAborted();
    const existing = opened.get(classId);
    if (existing) return existing.series;
    const series = await results.series(classId, signal);
    signal.throwIfAborted();
    if (closed) throw new Error('results service was closed');
    validateSeries(series);
    // Concurrent descriptions share one subscription and one stable series.
    const current = opened.get(classId);
    if (current) return current.series;
    const off = series.on('append', () =>
      service.emit({ classId, state: copyState(series.state) }),
    );
    opened.set(classId, { series, off });
    return series;
  }
  async function* batches(classId: string, signals: readonly number[] | null, signal: AbortSignal) {
    for await (const batch of results.read(classId, signals, signal)) {
      signal.throwIfAborted();
      if (batch.resultId !== results.id || batch.classId !== classId)
        throw new Error('batch disagrees with the requested result or class');
      // Readers lend their buffers. Transfer only owned copies.
      const frames = {
        ...batch,
        ...(batch.elements && { elements: batch.elements.slice() }),
        time: batch.time.slice(),
        values: batch.values.slice(),
      };
      yield transferred<Reply>({ op: 'read', frames }, [frames.time.buffer, frames.values.buffer]);
    }
  }
  async function answer(
    request: Exclude<Request, { op: 'read' }>,
    signal: AbortSignal,
  ): Promise<Reply> {
    const series = await get(request.classId, signal);
    switch (request.op) {
      case 'series':
        return {
          op: 'series',
          header: {
            elementCount: series.elementCount,
            signalCount: series.signalCount,
            ...(series.elements && { elements: series.elements.slice() }),
            state: copyState(series.state),
          },
        };
      case 'locate': {
        if (request.frameCount > series.state.frameCount)
          throw new RangeError('lookup exceeds committed frames');
        const bounds = await series.locate(request.range, request.frameCount, signal);
        signal.throwIfAborted();
        return { op: 'locate', bounds };
      }
      case 'samples': {
        const { frameOffset, frameCount, elementOffset, elementCount } = request.window;
        if (
          request.signalIndex >= series.signalCount ||
          frameOffset + frameCount > series.state.frameCount ||
          elementOffset + elementCount > series.elementCount
        )
          throw new RangeError('sample window exceeds the committed series');
        if (frameCount * (elementCount + 1) * 8 > maxBytes)
          throw new RangeError('sample window exceeds maxBytes');
        const block = await series.read(request.signalIndex, request.window, signal);
        signal.throwIfAborted();
        checkBlock(block, request.window);
        const values =
          block.values instanceof Float64Array
            ? new Float64Array(frameCount * elementCount)
            : new Float32Array(frameCount * elementCount);
        for (let f = 0; f < frameCount; f++)
          values.set(
            block.values.subarray(f * block.stride, f * block.stride + elementCount),
            f * elementCount,
          );
        return { op: 'samples', block: { time: block.time.slice(), values, stride: elementCount } };
      }
    }
  }
  const service = serve(
    port,
    resultsProtocol(results.id, options.maxSignals),
    (request, signal) => {
      if (request.op === 'read') return batches(request.classId, request.signals, signal);
      return answer(request, signal).then((reply) =>
        reply.op === 'samples'
          ? transferred(reply, [reply.block.time.buffer, reply.block.values.buffer])
          : reply,
      );
    },
    {
      onClose: () => {
        closed = true;
        for (const entry of opened.values()) entry.off();
        opened.clear();
      },
    },
  );
  return () => service.close();
}

/** Connect to one result by id. Its series subscribe automatically until the connection closes. */
export function connectResults(port: Port, id: string): Remote<Results> {
  if (!id) throw new Error('results need an id');
  const connection = connect(port, resultsProtocol(id));
  const opened = new Map<
    string,
    { series: Series; apply(state: Series['state']): void; clear(): void }
  >();
  const pending = new Map<string, { count: number; state?: Series['state'] }>();
  const off = connection.on(({ classId, state }) => {
    const entry = opened.get(classId);
    if (entry) entry.apply(state);
    else {
      const waiting = pending.get(classId);
      if (waiting && (!waiting.state || state.frameCount > waiting.state.frameCount))
        waiting.state = state;
    }
  });
  return {
    id,
    async series(classId, signal) {
      signal?.throwIfAborted();
      if (connection.closed) throw new Error(connection.closed);
      const existing = opened.get(classId);
      if (existing) return existing.series;
      const waiting = pending.get(classId) ?? { count: 0 };
      waiting.count++;
      pending.set(classId, waiting);
      try {
        const reply = await connection.call({ op: 'series', classId }, { signal });
        signal?.throwIfAborted();
        if (reply.op !== 'series') throw new Error('invalid series reply');
        const current = opened.get(classId);
        if (current) return current.series;
        let state = reply.header.state;
        const events = createEmitter<{ append: undefined }>();
        const series: Series = {
          ...reply.header,
          get state() {
            return state;
          },
          on: (event, listener) => events.on(event, listener),
          async read(signalIndex, window, abort) {
            const result = await connection.call(
              { op: 'samples', classId, signalIndex, window },
              { signal: abort },
            );
            abort?.throwIfAborted();
            if (result.op !== 'samples') throw new Error('invalid samples reply');
            checkBlock(result.block, window);
            return result.block;
          },
          async locate(range, frameCount, abort) {
            const result = await connection.call(
              { op: 'locate', classId, range, frameCount },
              { signal: abort },
            );
            abort?.throwIfAborted();
            if (
              result.op !== 'locate' ||
              !index(result.bounds[0]) ||
              !index(result.bounds[1]) ||
              result.bounds[0] > result.bounds[1] ||
              result.bounds[1] > frameCount
            )
              throw new Error('invalid time bounds reply');
            return result.bounds;
          },
        };
        validateSeries(series);
        const apply = (next: Series['state']): void => {
          if (next.frameCount <= state.frameCount) return;
          validateSeries({ ...series, state: next });
          state = next;
          events.emit('append', undefined);
        };
        if (waiting.state) apply(waiting.state);
        opened.set(classId, { series, apply, clear: () => events.clear() });
        return series;
      } finally {
        if (--waiting.count === 0) pending.delete(classId);
      }
    },
    async *read(classId, signals, signal) {
      for await (const reply of connection.stream({ op: 'read', classId, signals }, { signal })) {
        if (reply.op !== 'read' || reply.frames.resultId !== id || reply.frames.classId !== classId)
          throw new Error('invalid result batch reply');
        yield reply.frames;
      }
    },
    close() {
      off();
      connection.close();
      for (const entry of opened.values()) entry.clear();
      opened.clear();
      pending.clear();
    },
  };
}
function checkBlock(block: Block, window: Window): void {
  const required =
    window.frameCount && window.elementCount
      ? (window.frameCount - 1) * block.stride + window.elementCount
      : 0;
  if (
    !(block.time instanceof Float64Array) ||
    !(block.values instanceof Float32Array || block.values instanceof Float64Array) ||
    !index(block.stride) ||
    block.stride < window.elementCount ||
    block.time.length !== window.frameCount ||
    block.values.length < required
  )
    throw new Error('invalid samples block');
}
