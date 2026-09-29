/** Bounded series reads across a port, optionally pinned to the committed history at serve time. */
import { Series, validateDomain, validateSeries, type Domain } from '@latkit/model';
import { connect, serve, transferred, type Remote } from './channel.js';
import { check } from './check.js';
import { protocol } from './protocol.js';
import type { Port } from './port.js';

type Description = Series.Shape & { readonly state: Series.State };
type Request =
  | { readonly op: 'describe' }
  | { readonly op: 'changes' }
  | { readonly op: 'locate'; readonly range: Domain; readonly frameCount: number }
  | { readonly op: 'read'; readonly signalIndex: number; readonly window: Series.Window };
type Reply = Description | Series.State | Series.Block | readonly [number, number];
const MAX_BYTES = 4 << 20;
const seriesProtocol = (id?: string) =>
  protocol<Request, Reply>(
    id === undefined ? 'series' : `series:${id}`,
    check.requests<Request>({
      describe: {},
      changes: {},
      locate: { range: (value, name) => validateDomain(value, name), frameCount: check.index },
      read: {
        signalIndex: check.index,
        window: check.object<Series.Window>({
          frameOffset: check.index,
          frameCount: check.index,
          elementOffset: check.index,
          elementCount: check.index,
        }),
      },
    }),
  );
const copyState = (state: Series.State): Series.State => ({
  ...state,
  timeRange: state.timeRange ? [...state.timeRange] : null,
  ranges: state.ranges?.slice() ?? null,
});

/** Serve a borrowed series. Snapshot mode pins the committed prefix and never follows appends. */
export function serveSeries(
  port: Port,
  series: Series,
  options: {
    readonly id?: string;
    readonly snapshot?: boolean;
    onClose?(): void;
  } = {},
): () => void {
  validateSeries(series);
  const pinned = options.snapshot ? { ...copyState(series.state), live: false } : null;
  const state = (): Series.State => pinned ?? series.state;
  async function* changes(signal: AbortSignal): AsyncGenerator<Series.State> {
    let changed = true;
    let wake: (() => void) | undefined;
    const off = series.on('change', () => {
      changed = true;
      wake?.();
    });
    const abort = (): void => wake?.();
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        if (!changed)
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (signal.aborted) resolve();
          });
        if (signal.aborted) return;
        changed = false;
        const next = state();
        yield copyState(next);
        if (!next.live) return;
      }
    } finally {
      off();
      signal.removeEventListener('abort', abort);
    }
  }
  const calls = serve(
    port,
    seriesProtocol(options.id),
    (request, signal) => {
      switch (request.op) {
        case 'describe':
          return Promise.resolve({
            signals: [...series.signals],
            elementCount: series.elementCount,
            elements: series.elements?.slice(),
            state: copyState(state()),
          });
        case 'changes':
          return changes(signal);
        case 'locate': {
          if (request.frameCount > state().frameCount)
            throw new RangeError('locate exceeds committed series');
          return series.locate(request.range, request.frameCount, signal);
        }
        case 'read': {
          const w = request.window;
          if (w.frameOffset + w.frameCount > state().frameCount)
            throw new RangeError('read exceeds committed series');
          if (w.frameCount * (w.elementCount + 1) * 8 > MAX_BYTES)
            throw new RangeError('sample window exceeds 4 MiB');
          return series.read(request.signalIndex, w, signal).then((block) => {
            // Series.read borrows its buffers. Copy before transferring so the owner keeps them.
            if (
              !block ||
              !(block.time instanceof Float64Array) ||
              !(block.values instanceof Float32Array || block.values instanceof Float64Array) ||
              !Number.isSafeInteger(block.stride) ||
              block.stride < w.elementCount ||
              block.time.length !== w.frameCount
            )
              throw new TypeError('Invalid series sample block');
            const required =
              w.frameCount && w.elementCount
                ? (w.frameCount - 1) * block.stride + w.elementCount
                : 0;
            if (!Number.isSafeInteger(required) || block.values.length < required)
              throw new RangeError('Invalid series sample block');
            const time = block.time.slice();
            const count = w.frameCount * w.elementCount;
            const values =
              block.stride === w.elementCount
                ? block.values.slice(0, count)
                : block.values instanceof Float32Array
                  ? new Float32Array(count)
                  : new Float64Array(count);
            if (block.stride !== w.elementCount)
              for (let frame = 0; frame < w.frameCount; frame++)
                values.set(
                  block.values.subarray(
                    frame * block.stride,
                    frame * block.stride + w.elementCount,
                  ),
                  frame * w.elementCount,
                );
            return transferred({ time, values, stride: w.elementCount }, [
              time.buffer,
              values.buffer,
            ]);
          });
        }
      }
    },
    { onClose: options.onClose },
  );
  return () => calls.close();
}

/** Connect a series without loading its samples; close releases the connection, never the source. */
export async function connectSeries(
  port: Port,
  options: {
    readonly id?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Remote<Series>> {
  const calls = connect(port, seriesProtocol(options.id));
  try {
    const description = (await calls.call(
      { op: 'describe' },
      { signal: options.signal },
    )) as Description;
    class Connected extends Series {
      #failure: Error | null = null;
      #closed = false;
      constructor() {
        super(description);
        this.publish(description.state);
      }
      override async read(
        signalIndex: number,
        window: Series.Window,
        signal?: AbortSignal,
      ): Promise<Series.Block> {
        if (this.#failure) throw this.#failure;
        return super.read(signalIndex, window, signal);
      }
      async locate(
        range: Domain,
        frameCount: number,
        signal?: AbortSignal,
      ): Promise<readonly [number, number]> {
        if (this.#failure) throw this.#failure;
        validateDomain(range, 'range');
        return calls.call({ op: 'locate', range, frameCount }, { signal }) as Promise<
          readonly [number, number]
        >;
      }
      protected fetch(
        signalIndex: number,
        window: Series.Window,
        signal?: AbortSignal,
      ): Promise<Series.Block> {
        return calls.call({ op: 'read', signalIndex, window }, { signal }) as Promise<Series.Block>;
      }
      async follow(): Promise<void> {
        for await (const next of calls.stream({ op: 'changes' })) {
          if (this.#closed) return;
          this.publish(next as Series.State);
        }
        if (!this.#closed && this.state.live) throw new Error('Series stream ended before sealing');
      }
      fail(cause: unknown): void {
        if (this.#closed) return;
        this.#failure = cause instanceof Error ? cause : new Error(String(cause));
        // No further appends can arrive. Keep the last valid prefix and its original failure.
        this.publish({ ...this.state, live: false });
        this.close();
      }
      close(): void {
        if (this.#closed) return;
        this.#closed = true;
        calls.close();
        this.silence();
      }
    }
    const connected = new Connected();
    if (description.state.live)
      void connected.follow().catch((error: unknown) => connected.fail(error));
    return connected;
  } catch (error) {
    calls.close();
    throw error;
  }
}
