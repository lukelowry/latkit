/**
 * A recording: every signal an engine records for one model, each class's series on one clock so
 * frame `f` is one instant in each of them. `Engine.record` begins one; `Recording.from` opens one
 * held elsewhere, across a port or in a file, against the model it records.
 */

import { validateDomain, type Domain } from './domain.js';
import type { Engine } from './engine.js';
import { checkRef, fieldOf } from './field.js';
import { createGrid } from './grid.js';
import { listeners } from './listeners.js';
import type { Model } from './model.js';
import { Clock, Sourced, Tracked, type Series } from './series.js';

/**
 * Begin a recording of `model`, holding every class that records a signal, and `fill` it through
 * the recorder it is given. Only `Engine.record` calls it.
 */
export let begin: (
  model: Model,
  header: { readonly id?: string; readonly label?: string },
  fill: (recorder: Engine.Recorder) => Promise<void>,
) => Recording;

const STATUSES: readonly Recording.State['status'][] = [
  'waiting',
  'recording',
  'complete',
  'stopped',
  'failed',
];
const LEVELS: readonly Recording.Entry['level'][] = ['info', 'warn', 'error'];

let recordings = 0;

/**
 * Every signal an engine records for one model, each class's series on one clock. It exists
 * before its first frame, so a host binds its fields at once and they follow it as frames arrive;
 * its state says whether it waits, records, or ended, and why. It stays the recording of its
 * model: its fields and grids read that model, whatever becomes of the case since.
 */
export class Recording {
  /** The model it records: the case exactly as it was recorded. */
  readonly model: Model;
  readonly id: string;
  readonly label: string;
  /** The classes it records, in model order; `series` resolves each. */
  readonly classes: readonly string[];
  #span: Domain | null = null;
  #expectedFrames: number | null = null;
  #state: Recording.State = Object.freeze({
    status: 'waiting',
    ahead: 0,
    frameCount: 0,
    timeRange: null,
    error: null,
  });
  readonly #log: Recording.Entry[] = [];
  readonly #clock: Clock;
  readonly #series: ReadonlyMap<string, Series>;
  readonly #changes = listeners();
  #halt: () => void = () => undefined;

  private constructor(
    model: Model,
    id: string,
    label: string,
    clock: Clock,
    series: ReadonlyMap<string, Series>,
  ) {
    this.model = model;
    this.id = id;
    this.label = label;
    this.classes = Object.freeze([...series.keys()]);
    this.#clock = clock;
    this.#series = series;
  }

  /** The time it spans, as its engine declares it; null until it does. */
  get span(): Domain | null {
    return this.#span;
  }

  /** The frames its engine expects it to hold; null when it cannot say. */
  get expectedFrames(): number | null {
    return this.#expectedFrames;
  }

  /** Where it stands, published atomically; a previous state never changes. */
  get state(): Recording.State {
    return this.#state;
  }

  /** What its engine said while recording, in order; it grows as the engine logs. */
  get log(): readonly Recording.Entry[] {
    return this.#log;
  }

  /**
   * The latest frame at or before `time`, the first before the recording starts; -1 while empty.
   *
   * @throws RangeError when `time` is not finite.
   */
  frameAt(time: number): number {
    return this.#clock.frameAt(time);
  }

  /**
   * The time of committed `frame`.
   *
   * @throws RangeError for a frame the recording has not committed.
   */
  timeAt(frame: number): number {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= this.#state.frameCount)
      throw new RangeError(`frame ${frame} is not committed`);
    return this.#clock.timeAt(frame);
  }

  /** One class's history on this clock, or null for a class it does not record. */
  series(classId: string): Series | null {
    return this.#series.get(classId) ?? null;
  }

  /**
   * A signal it records, or a column of its model, resolved to the `{ series, signal }` a
   * renderer binds; null when neither has values for it. A signal reads at this recording's clock,
   * and one reference resolves to one series, so the renderers binding it share its frames.
   *
   * @throws TypeError when `ref` is not a field reference.
   */
  async field(ref: Model.FieldRef, signal?: AbortSignal): Promise<Model.Field | null> {
    checkRef(ref);
    if (ref.kind === 'column') return this.model.field(ref, signal);
    signal?.throwIfAborted();
    const spec = this.model.class(ref.classId);
    const declared = spec?.signals.find((candidate) => candidate.id === ref.id);
    const series = this.#series.get(ref.classId);
    const index = declared && series ? series.signals.indexOf(declared.id) : -1;
    if (!spec || !declared || !series || index < 0) return null;
    return fieldOf(ref, declared.label, declared.unit, series, index, spec.count, (time) =>
      this.frameAt(time),
    );
  }

  /**
   * One class of its model as a table: its labels and columns, then every signal it records for
   * the class, sampled at `time`.
   *
   * @throws Error for a class its model lacks; RangeError when `time` is not finite.
   */
  async grid(classId: string, time: number, signal?: AbortSignal): Promise<Model.Grid> {
    const spec = this.model.class(classId);
    if (!spec) throw new Error(`unknown class '${classId}'`);
    if (!Number.isFinite(time)) throw new RangeError('grid time must be finite');
    const data = await this.model.load(classId, signal);
    const sampled = await Promise.all(
      spec.signals.map(async (declared): Promise<Model.Data['columns'][number] | null> => {
        const field = await this.field({ classId, kind: 'signal', id: declared.id }, signal);
        if (!field) return null;
        const values = await field.at(time, signal);
        return {
          kind: 'number',
          id: declared.id,
          label: declared.label,
          unit: declared.unit,
          values: values instanceof Float64Array ? values : Float64Array.from(values),
        };
      }),
    );
    signal?.throwIfAborted();
    return createGrid(
      data.labels,
      data.columns,
      sampled.filter((column) => column !== null),
    );
  }

  /**
   * No more frames, keeping what it has: a recording that waits never starts, one that records
   * stops its engine, and one opened from a source stops following it.
   */
  stop(): void {
    this.#halt();
  }

  /** It changed: frames, where it stands, what it spans, or its log. Every series changes first. */
  on(_event: 'change', listener: () => void): () => void {
    return this.#changes.on(listener);
  }

  /** The recording as a source: what `Recording.from` opens it from, elsewhere. */
  source(): Recording.Source {
    const series = this.#series;
    return {
      describe: (signal) =>
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return {
            id: this.id,
            label: this.label,
            classes: [...series].map(([classId, history]) => ({
              classId,
              signals: [...history.signals],
              elementCount: history.elementCount,
              ...(history.elements && { elements: history.elements.slice() }),
            })),
          };
        }),
      changes: (signal) => this.#follow(signal),
      read: async (classId, signalIndex, window, signal) => {
        const history = series.get(classId);
        if (!history) throw new RangeError(`recording '${this.id}' has no class '${classId}'`);
        const block = await history.read(signalIndex, window, signal);
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

  /**
   * Open the recording of `model` that `source` holds: its classes and clock arrive before this
   * resolves, so `frameAt`, `timeAt`, and every series' `locate` answer at once, and a series reads
   * its samples from the source. It follows the source until stopped; closing it closes the source.
   *
   * @throws Error, TypeError, or RangeError when the source describes an invalid recording or one
   * that does not fit `model`, and whatever the source throws; the source is closed then too.
   */
  static async from(
    model: Model,
    source: Recording.Source,
    signal?: AbortSignal,
  ): Promise<Recording & { close(): void }> {
    try {
      return await Recording.#open(model, source, signal);
    } catch (error) {
      source.close?.();
      throw error;
    }
  }

  static async #open(
    model: Model,
    source: Recording.Source,
    signal?: AbortSignal,
  ): Promise<Recording & { close(): void }> {
    signal?.throwIfAborted();
    const described = await source.describe(signal);
    signal?.throwIfAborted();
    if (!described || typeof described !== 'object')
      throw new TypeError('a recording source must describe its recording');
    const { id, label, classes } = described;
    if (typeof id !== 'string' || id === '') throw new Error('recording id must be non-empty');
    if (typeof label !== 'string') throw new TypeError('recording label must be a string');
    if (!Array.isArray(classes as unknown))
      throw new TypeError('a recording source must list its classes');
    const clock = new Clock();
    const mirrors = new Map<string, Sourced>();
    for (const entry of classes) {
      const classId = entry?.classId;
      if (typeof classId !== 'string' || classId === '' || mirrors.has(classId))
        throw new Error('a recording source must name each class once');
      const mirror = new Sourced(clock, entry, (signalIndex, window, reading) =>
        source.read(classId, signalIndex, window, reading),
      );
      fits(model, classId, mirror);
      mirrors.set(classId, mirror);
    }
    const recording = new Recording(model, id, label, clock, mirrors);

    /** Commit one change, checked whole before anything moves. */
    const apply = (change: unknown): void => {
      if (!change || typeof change !== 'object') throw new TypeError('a change must be an object');
      const { time, ranges, status, ahead, error, span, expectedFrames, log } = change as Record<
        string,
        unknown
      >;
      const committed = clock.admit(time);
      if (!STATUSES.includes(status as Recording.State['status']))
        throw new TypeError('a change says where its recording stands');
      if (!Number.isSafeInteger(ahead) || (ahead as number) < 0)
        throw new RangeError('a change says how many wait ahead');
      if (error !== null && typeof error !== 'string')
        throw new TypeError('a change says why its recording failed, or null');
      const nextSpan = checkedSpan(span ?? null);
      const nextExpected = checkedFrames(expectedFrames ?? null);
      if (!Array.isArray(log) || !log.every(isEntry))
        throw new TypeError('a change carries the lines logged since the last');
      if (!ranges || typeof ranges !== 'object') throw new TypeError('a change carries ranges');
      const next = new Map<string, Float64Array | null>();
      for (const [classId, mirror] of mirrors) {
        const range = (ranges as Record<string, unknown>)[classId] ?? null;
        if (
          range !== null &&
          (!(range instanceof Float64Array) || range.length !== mirror.signals.length * 2)
        )
          throw new RangeError('series ranges must contain one f64 pair per signal');
        next.set(classId, range);
      }
      if (committed.length) clock.commit(committed);
      if (!live(status as Recording.State['status'])) clock.seal();
      for (const [classId, mirror] of mirrors) mirror.follow(next.get(classId)!);
      recording.#span = nextSpan;
      recording.#expectedFrames = nextExpected;
      recording.#log.push(
        ...(log as Recording.Entry[]).map((entry) => Object.freeze({ ...entry })),
      );
      recording.#set({
        status: status as Recording.State['status'],
        ahead: ahead as number,
        error: error as string | null,
        frameCount: clock.frameCount,
        timeRange: clock.timeRange,
      });
    };

    const following = new AbortController();
    const changes = source.changes(following.signal)[Symbol.asyncIterator]();
    /** Stop following the source, keeping what it holds. */
    const halt = (): void => {
      if (following.signal.aborted) return;
      following.abort();
      if (live(recording.#state.status)) {
        clock.seal();
        for (const mirror of mirrors.values()) mirror.follow(mirror.state.ranges);
        recording.#set({ status: 'stopped', ahead: 0 });
      }
    };
    const abort = (): void => following.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const first = await changes.next();
      signal?.throwIfAborted();
      if (first.done) throw new Error('a recording source ended before its clock');
      apply(first.value);
    } catch (error) {
      following.abort();
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
    recording.#halt = halt;
    let closed = false;
    return Object.assign(recording, {
      close() {
        if (closed) return;
        closed = true;
        halt();
        recording.#changes.clear();
        for (const mirror of mirrors.values()) mirror.forget();
        source.close?.();
      },
    });
  }

  static {
    begin = (model, header, fill) => {
      const id = header.id ?? `recording-${++recordings}`;
      const clock = new Clock();
      const tracks = new Map<string, Tracked>();
      for (const spec of model.classes) {
        const signals = spec.signals.filter((signal) => signal.recorded).map((signal) => signal.id);
        if (signals.length)
          tracks.set(spec.id, new Tracked(clock, { signals, elementCount: spec.count }));
      }
      const recording = new Recording(model, id, header.label ?? id, clock, tracks);
      const control = new AbortController();
      const ended = (): boolean => !live(recording.#state.status);
      /** Seal the clock and every series, and say how it ended. */
      const end = (status: 'complete' | 'stopped' | 'failed', error: string | null): void => {
        if (ended()) return;
        if (clock.seal()) for (const track of tracks.values()) track.update();
        recording.#set({ status, ahead: 0, error });
      };
      const recorder: Engine.Recorder = {
        signal: control.signal,
        ready: Promise.resolve(),
        declare(extent) {
          if (ended()) return;
          const span = extent.span === undefined ? recording.#span : checkedSpan(extent.span);
          const expected =
            extent.expectedFrames === undefined
              ? recording.#expectedFrames
              : checkedFrames(extent.expectedFrames);
          recording.#span = span;
          recording.#expectedFrames = expected;
          recording.#set({});
        },
        wait(ahead) {
          if (ended()) return;
          if (!Number.isSafeInteger(ahead) || ahead < 0)
            throw new RangeError('ahead must be a nonnegative safe integer');
          recording.#set({ status: 'waiting', ahead });
        },
        start() {
          if (!ended()) recording.#set({ status: 'recording', ahead: 0 });
        },
        append(time, values) {
          if (ended()) throw new Error('frames cannot follow a recording that ended');
          const admitted = clock.admit(time);
          const given = values as unknown;
          if (!given || typeof given !== 'object' || Array.isArray(given))
            throw new TypeError('frames values must map class ids to values');
          const lanes = new Map<Tracked, Float32Array | Float64Array>();
          for (const [classId, block] of Object.entries(given)) {
            const track = tracks.get(classId);
            if (!track) throw new RangeError(`the recording does not record class '${classId}'`);
            lanes.set(track, track.admit(block, admitted.length));
          }
          if (!admitted.length) return;
          clock.commit(admitted);
          for (const track of tracks.values())
            track.push(lanes.get(track) ?? null, admitted.length, false);
          for (const track of tracks.values()) track.update();
          recording.#set({ status: 'recording', ahead: 0 });
        },
        log(level, message) {
          if (ended()) return;
          if (!LEVELS.includes(level) || typeof message !== 'string')
            throw new TypeError('a log line has a level and a message');
          recording.#log.push(Object.freeze({ level, message }));
          recording.#set({});
        },
      };
      recording.#halt = () => {
        if (ended()) return;
        control.abort();
        end('stopped', null);
      };
      void fill(recorder).then(
        () => end('complete', null),
        (error: unknown) =>
          control.signal.aborted
            ? end('stopped', null)
            : end('failed', error instanceof Error ? error.message : 'the engine failed'),
      );
      return recording;
    };
  }

  /** Publish its state with `patch` and the clock as it stands, and tell every listener. */
  #set(patch: Partial<Recording.State>): void {
    this.#state = Object.freeze({
      ...this.#state,
      ...patch,
      frameCount: this.#clock.frameCount,
      timeRange: this.#clock.timeRange,
    });
    this.#changes.emit();
  }

  /** Its changes as a source gives them: the clock and log so far first, then each change. */
  async *#follow(signal?: AbortSignal): AsyncGenerator<Recording.Change> {
    let sent = -1;
    let logged = 0;
    let told: Recording.State | null = null;
    let wake: (() => void) | null = null;
    const resume = (): void => {
      const pending = wake;
      wake = null;
      pending?.();
    };
    const off = this.on('change', resume);
    signal?.addEventListener('abort', resume);
    try {
      for (;;) {
        if (signal?.aborted) return;
        const state = this.#state;
        if (state !== told) {
          const time = this.#clock.slice(Math.max(0, sent), state.frameCount);
          const log = this.#log.slice(logged);
          sent = state.frameCount;
          logged += log.length;
          told = state;
          yield {
            time,
            ranges: Object.fromEntries(
              [...this.#series].map(([classId, history]) => [
                classId,
                history.state.ranges?.slice() ?? null,
              ]),
            ),
            status: state.status,
            ahead: state.ahead,
            error: state.error,
            span: this.#span,
            expectedFrames: this.#expectedFrames,
            log,
          };
          if (!live(state.status)) return;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      off();
      signal?.removeEventListener('abort', resume);
    }
  }
}

/** Where a recording stands, what its engine logged, and the source it opens from. */
export declare namespace Recording {
  /** Where a recording stands. */
  interface State {
    /**
     * `waiting` its turn, `recording` as frames arrive, then `complete`, `stopped` by its host, or
     * `failed`.
     */
    readonly status: 'waiting' | 'recording' | 'complete' | 'stopped' | 'failed';
    /** Recordings waiting before it while it waits. */
    readonly ahead: number;
    readonly frameCount: number;
    readonly timeRange: Domain | null;
    /** Why it failed; null otherwise. */
    readonly error: string | null;
  }
  /** One line its engine logged. */
  interface Entry {
    readonly level: 'info' | 'warn' | 'error';
    readonly message: string;
  }
  /**
   * One change a source gives: the times committed since the change before (every one in the
   * first), each class's recorded ranges as of it, an f64 pair per signal, where it stands, what
   * it spans, and the lines logged since the change before (every one in the first).
   */
  interface Change {
    readonly time: Float64Array;
    readonly ranges: Readonly<Record<string, Float64Array | null>>;
    readonly status: State['status'];
    readonly ahead: number;
    readonly error: string | null;
    readonly span: Domain | null;
    readonly expectedFrames: number | null;
    readonly log: readonly Entry[];
  }
  /**
   * A recording held elsewhere, as `Recording.from` opens it: its shape at once, its changes as it
   * grows, and sample windows when asked. Every buffer it returns is the caller's; a transport may
   * detach it. A source that holds resources releases them in `close`.
   */
  interface Source {
    /** Its id and label, and each class it records: signals in frame order, and elements. */
    describe(signal?: AbortSignal): Promise<{
      readonly id: string;
      readonly label: string;
      readonly classes: readonly (Series.Shape & { readonly classId: string })[];
    }>;
    /** The changes from its first, until it ends. Iterate once. */
    changes(signal?: AbortSignal): AsyncIterable<Change>;
    /** One window of one class's signal, one row of `window.elementCount` values per frame. */
    read(
      classId: string,
      signalIndex: number,
      window: Series.Window,
      signal?: AbortSignal,
    ): Promise<Series.Block>;
    close?(): void;
  }
}

/** Whether a recording in `status` may still grow. */
function live(status: Recording.State['status']): boolean {
  return status === 'waiting' || status === 'recording';
}

/**
 * Check that the series a source holds for `classId` is one `model` records: a class it declares,
 * signals that class declares, and elements within it.
 *
 * @throws Error naming what does not fit.
 */
function fits(model: Model, classId: string, series: Series): void {
  const spec = model.class(classId);
  if (!spec) throw new Error(`the recording holds class '${classId}', which its model lacks`);
  for (const id of series.signals)
    if (!spec.signals.some((declared) => declared.id === id))
      throw new Error(
        `the recording holds signal '${id}', which class '${classId}' does not declare`,
      );
  const { elements } = series;
  const fitsCount = elements
    ? elements.length === 0 || elements[elements.length - 1]! < spec.count
    : series.elementCount === spec.count;
  if (!fitsCount)
    throw new Error(`the recording's '${classId}' elements do not fit its model's ${spec.count}`);
}

function isEntry(value: unknown): value is Recording.Entry {
  if (!value || typeof value !== 'object') return false;
  const { level, message } = value as Record<string, unknown>;
  return LEVELS.includes(level as Recording.Entry['level']) && typeof message === 'string';
}

/** A declared span, checked and owned. */
function checkedSpan(span: unknown): Domain | null {
  if (span === null) return null;
  validateDomain(span, 'recording span');
  return Object.freeze([span[0], span[1]]) as Domain;
}

/** A declared frame count, checked. */
function checkedFrames(frames: unknown): number | null {
  if (frames === null) return null;
  if (typeof frames !== 'number' || !Number.isSafeInteger(frames) || frames < 0)
    throw new RangeError('expectedFrames must be a nonnegative safe integer');
  return frames;
}
