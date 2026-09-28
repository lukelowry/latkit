/**
 * A recording: one run's output, a series per recorded class, every class on one clock so frame
 * `f` is one instant in each of them. `Model.record` makes the one a run fills; `openRecording`
 * opens one held elsewhere, across a port or in a file, from its source.
 */

import { validateDomain, type Domain } from './domain.js';
import { listeners } from './listeners.js';
import type { RunFrames } from './run.js';
import {
  Clock,
  sourced,
  track,
  type Block,
  type Series,
  type Shape,
  type Track,
  type Window,
} from './series.js';

/** One run's output: a series per recorded class, every class on one clock. */
export interface Recording {
  readonly id: string;
  readonly label: string;
  /** Declared before any frame arrives: the time a timeline spans; null when nobody said. */
  readonly span: Domain | null;
  /** Declared before any frame arrives: the frames progress counts to; null when nobody can say. */
  readonly expectedFrames: number | null;
  /** The classes it records, in model order; `series` resolves each. */
  readonly classes: readonly string[];
  /** The clock every class shares, published atomically; a previous state never changes. */
  readonly state: {
    readonly frameCount: number;
    readonly timeRange: Domain | null;
    readonly live: boolean;
  };
  /**
   * The latest frame at or before `time`, the first before the recording starts; -1 while empty.
   *
   * @throws RangeError when `time` is not finite.
   */
  frameAt(time: number): number;
  /**
   * The time of committed `frame`.
   *
   * @throws RangeError for a frame the recording has not committed.
   */
  timeAt(frame: number): number;
  /** One class's history on this clock, or null for a class it does not record. */
  series(classId: string, signal?: AbortSignal): Promise<Series | null>;
  /** The recording as a source: what `openRecording` opens it from, elsewhere. */
  source(): RecordingSource;
  /** Its state changed: frames were appended, or it was sealed. Every series changes first. */
  on(event: 'change', listener: () => void): () => void;
}

/**
 * A recording held elsewhere, as `openRecording` opens it: its declaration and shape at once, its
 * clock as it grows, and sample windows when asked.
 *
 * @remarks
 * Every buffer a source returns belongs to the caller; a transport may detach it. A source that
 * holds resources releases them in `close`.
 */
export interface RecordingSource {
  /** What the recording declares, and each class it records: signals in frame order, elements. */
  describe(signal?: AbortSignal): Promise<{
    readonly id: string;
    readonly label: string;
    readonly span: Domain | null;
    readonly expectedFrames: number | null;
    readonly classes: readonly (Shape & { readonly classId: string })[];
  }>;
  /**
   * The clock from its first frame, then each change, until the seal: `time` holds the times
   * committed since the item before, every one so far in the first; `ranges` holds each class's
   * recorded ranges as of it, an f64 pair per signal. Iterate once.
   */
  changes(signal?: AbortSignal): AsyncIterable<{
    readonly time: Float64Array;
    readonly live: boolean;
    readonly ranges: Readonly<Record<string, Float64Array | null>>;
  }>;
  /** One window of one class's signal, one row of `window.elementCount` values per frame. */
  read(classId: string, signalIndex: number, window: Window, signal?: AbortSignal): Promise<Block>;
  close?(): void;
}

/** What a recording declares before its run starts. */
export interface Header {
  readonly id: string;
  readonly label?: string;
  readonly span?: Domain | null;
  readonly expectedFrames?: number | null;
}

type Declared = Pick<Recording, 'id' | 'label' | 'span' | 'expectedFrames'>;

/** A header checked and owned. */
function declare(header: Header): Declared {
  if (!header || typeof header !== 'object')
    throw new TypeError('recording header must be an object');
  const { id } = header;
  if (typeof id !== 'string' || id === '') throw new Error('recording id must be non-empty');
  const label = header.label ?? id;
  if (typeof label !== 'string') throw new TypeError('recording label must be a string');
  let span: Domain | null = null;
  if (header.span !== undefined && header.span !== null) {
    validateDomain(header.span, 'recording span');
    span = Object.freeze([header.span[0], header.span[1]]) as Domain;
  }
  const expectedFrames = header.expectedFrames ?? null;
  if (expectedFrames !== null && (!Number.isSafeInteger(expectedFrames) || expectedFrames < 0))
    throw new RangeError('recording expectedFrames must be a nonnegative safe integer');
  return { id, label, span, expectedFrames };
}

/** The recording `declared` names over `clock` and a series per class; its owner publishes it. */
function assemble(
  declared: Declared,
  clock: Clock,
  histories: ReadonlyMap<string, Series>,
): { readonly recording: Recording; publish(): void; clear(): void } {
  const changes = listeners();
  let state = snapshot();

  function snapshot(): Recording['state'] {
    return Object.freeze({
      frameCount: clock.frameCount,
      timeRange: clock.timeRange,
      live: clock.live,
    });
  }

  const recording: Recording = {
    ...declared,
    classes: Object.freeze([...histories.keys()]),
    get state() {
      return state;
    },
    frameAt: (time) => clock.frameAt(time),
    timeAt(frame) {
      if (!Number.isSafeInteger(frame) || frame < 0 || frame >= state.frameCount)
        throw new RangeError(`frame ${frame} is not committed`);
      return clock.timeAt(frame);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- a recording held elsewhere resolves its series at once too
    async series(classId, signal) {
      signal?.throwIfAborted();
      return histories.get(classId) ?? null;
    },
    source: () => sourceOf(recording),
    on: (_event, listener) => changes.on(listener),
  };
  return {
    recording,
    publish() {
      state = snapshot();
      changes.emit();
    },
    clear: () => changes.clear(),
  };
}

/**
 * The recording `header` names over `classes`, empty and live until its run appends and seals it.
 *
 * @throws Error, TypeError, or RangeError when the header is invalid.
 */
export function createRecording(
  header: Header,
  classes: readonly (Shape & { readonly classId: string })[],
): Recording & { append(frames: RunFrames): void; seal(): void } {
  const declared = declare(header);
  const clock = new Clock();
  const tracks = new Map<string, Track>();
  for (const { classId, ...shape } of classes) tracks.set(classId, track(clock, shape));
  const assembled = assemble(
    declared,
    clock,
    new Map([...tracks].map(([classId, history]) => [classId, history.series])),
  );

  function publish(): void {
    for (const history of tracks.values()) history.publish();
    assembled.publish();
  }

  return Object.assign(assembled.recording, {
    append(frames: RunFrames) {
      if (!frames || typeof frames !== 'object') throw new TypeError('frames must be an object');
      const time = clock.admit(frames.time);
      const given = frames.values as unknown;
      if (!given || typeof given !== 'object' || Array.isArray(given))
        throw new TypeError('frames values must map class ids to values');
      const lanes = new Map<Track, Float32Array | Float64Array>();
      for (const [classId, values] of Object.entries(given)) {
        const history = tracks.get(classId);
        if (!history) throw new RangeError(`the recording does not record class '${classId}'`);
        lanes.set(history, history.admit(values, time.length));
      }
      if (!time.length) return;
      clock.commit(time);
      for (const history of tracks.values())
        history.push(lanes.get(history) ?? null, time.length, false);
      publish();
    },
    seal() {
      if (clock.seal()) publish();
    },
  });
}

/**
 * Open the recording `source` holds: its declaration and clock arrive before this resolves, so
 * `frameAt`, `timeAt`, and every series' `locate` answer at once, and a series reads its samples
 * from the source. The recording follows the source's changes until it is closed; closing it
 * closes the source.
 *
 * @throws Error, TypeError, or RangeError when the source describes an invalid recording, and
 * whatever the source throws; the source is closed then too.
 */
export async function openRecording(
  source: RecordingSource,
  signal?: AbortSignal,
): Promise<Recording & { close(): void }> {
  try {
    return await open(source, signal);
  } catch (error) {
    source.close?.();
    throw error;
  }
}

async function open(
  source: RecordingSource,
  signal?: AbortSignal,
): Promise<Recording & { close(): void }> {
  signal?.throwIfAborted();
  const described = await source.describe(signal);
  signal?.throwIfAborted();
  const declared = declare(described);
  if (typeof described.label !== 'string') throw new TypeError('recording label must be a string');
  if (!Array.isArray(described.classes as unknown))
    throw new TypeError('a recording source must list its classes');
  const clock = new Clock();
  const mirrors = new Map<string, ReturnType<typeof sourced>>();
  for (const entry of described.classes) {
    const classId = entry?.classId;
    if (typeof classId !== 'string' || classId === '' || mirrors.has(classId))
      throw new Error('a recording source must name each class once');
    mirrors.set(
      classId,
      sourced(clock, entry, (signalIndex, window, readSignal) =>
        source.read(classId, signalIndex, window, readSignal),
      ),
    );
  }
  const assembled = assemble(
    declared,
    clock,
    new Map([...mirrors].map(([classId, mirror]) => [classId, mirror.series])),
  );

  /** Commit one change, checked whole before anything moves. */
  function apply(change: unknown): void {
    if (!change || typeof change !== 'object') throw new TypeError('a change must be an object');
    const { time, live, ranges } = change as Record<string, unknown>;
    const committed = clock.admit(time);
    if (typeof live !== 'boolean') throw new TypeError('a change says whether it is live');
    if (!ranges || typeof ranges !== 'object') throw new TypeError('a change carries ranges');
    const next = new Map<string, Float64Array | null>();
    for (const [classId, mirror] of mirrors) {
      const range = (ranges as Record<string, unknown>)[classId] ?? null;
      if (
        range !== null &&
        (!(range instanceof Float64Array) || range.length !== mirror.series.signals.length * 2)
      )
        throw new RangeError('series ranges must contain one f64 pair per signal');
      next.set(classId, range);
    }
    if (committed.length) clock.commit(committed);
    if (!live) clock.seal();
    for (const [classId, mirror] of mirrors) mirror.publish(next.get(classId)!);
    assembled.publish();
  }

  const following = new AbortController();
  const changes = source.changes(following.signal)[Symbol.asyncIterator]();
  /** Stop following the source and telling listeners. */
  function stop(): void {
    following.abort();
    assembled.clear();
    for (const mirror of mirrors.values()) mirror.clear();
  }
  const abort = (): void => following.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const first = await changes.next();
    signal?.throwIfAborted();
    if (first.done) throw new Error('a recording source ended before its clock');
    apply(first.value);
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  void (async () => {
    // A source that breaks or closes leaves the recording with what it had.
    try {
      for (;;) {
        const next = await changes.next();
        if (next.done) return;
        apply(next.value);
      }
    } catch {
      following.abort();
    }
  })();
  let closed = false;
  return Object.assign(assembled.recording, {
    close() {
      if (closed) return;
      closed = true;
      stop();
      source.close?.();
    },
  });
}

/** `recording` as a source: its declaration, its clock as it grows, and owned sample windows. */
export function sourceOf(recording: Recording): RecordingSource {
  let resolving: Promise<ReadonlyMap<string, Series>> | null = null;
  const histories = (): Promise<ReadonlyMap<string, Series>> =>
    (resolving ??= Promise.all(
      recording.classes.map(async (classId) => {
        const series = await recording.series(classId);
        if (!series) throw new Error(`recording '${recording.id}' has no series for '${classId}'`);
        return [classId, series] as const;
      }),
    ).then((entries) => new Map(entries)));
  return {
    async describe(signal) {
      signal?.throwIfAborted();
      const resolved = await histories();
      return {
        id: recording.id,
        label: recording.label,
        span: recording.span,
        expectedFrames: recording.expectedFrames,
        classes: [...resolved].map(([classId, series]) => ({
          classId,
          signals: [...series.signals],
          elementCount: series.elementCount,
          ...(series.elements && { elements: series.elements.slice() }),
        })),
      };
    },
    async *changes(signal) {
      const resolved = await histories();
      let sent = -1;
      let wake: (() => void) | null = null;
      const resume = (): void => {
        const pending = wake;
        wake = null;
        pending?.();
      };
      const off = recording.on('change', resume);
      signal?.addEventListener('abort', resume);
      try {
        for (;;) {
          if (signal?.aborted) return;
          const { frameCount, live } = recording.state;
          if (sent < 0 || frameCount > sent || !live) {
            const from = Math.max(0, sent);
            const time = new Float64Array(frameCount - from);
            for (let frame = from; frame < frameCount; frame++)
              time[frame - from] = recording.timeAt(frame);
            sent = frameCount;
            yield {
              time,
              live,
              ranges: Object.fromEntries(
                [...resolved].map(([classId, series]) => [
                  classId,
                  series.state.ranges?.slice() ?? null,
                ]),
              ),
            };
            if (!live) return;
            continue;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        off();
        signal?.removeEventListener('abort', resume);
      }
    },
    async read(classId, signalIndex, window, signal) {
      const series = (await histories()).get(classId);
      if (!series) throw new RangeError(`recording '${recording.id}' has no class '${classId}'`);
      const block = await series.read(signalIndex, window, signal);
      // A series lends its buffers: the caller gets a copy of its own, one row per frame.
      const { frameCount, elementCount } = window;
      const values =
        block.values instanceof Float64Array
          ? new Float64Array(frameCount * elementCount)
          : new Float32Array(frameCount * elementCount);
      for (let frame = 0; frame < frameCount; frame++)
        values.set(
          block.values.subarray(frame * block.stride, frame * block.stride + elementCount),
          frame * elementCount,
        );
      return { time: block.time.slice(), values, stride: elementCount };
    },
  };
}
