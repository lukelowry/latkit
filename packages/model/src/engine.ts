/**
 * An engine: what records a model. A host has it record any model into a recording; a transport
 * has it record into a recorder that forwards. The studies it offers are the forms a host fills to
 * name an input.
 */

import type { Domain } from './domain.js';
import { checkStudy, problemsOf, shownOf, valuesOf } from './form.js';
import { listeners } from './listeners.js';
import type { Model } from './model.js';
import { begin, type Recording } from './recording.js';
import { Refusal } from './refusal.js';

/** One recording waiting its turn. */
interface Waiting {
  readonly recorder: Engine.Recorder;
  start(): void;
  leave(): void;
}

/**
 * What records a model: a simulator, a solver, an analysis, a feed. Subclass it: `parse` what an
 * input may be, and `execute` one, writing frames through the recorder. One engine records any
 * model it is given; the base runs as many recordings at once as its concurrency allows and
 * queues the rest in order, telling each how many wait before it. Once it offers a study, an
 * engine records only an input that names one it offers, `{ study, values }`, and the base checks
 * the values against that study's form before `parse` sees them.
 */
export abstract class Engine {
  /** Recordings it makes at once; the rest wait their turn, in order. */
  readonly concurrency: number;
  #running = 0;
  readonly #waiting: Waiting[] = [];
  /** The studies it offers, by id, in the order each was first offered. */
  readonly #studies = new Map<string, Engine.Study>();
  #offered: readonly Engine.Study[] = Object.freeze([]);
  /** Whether it has offered a study, and so records only an input that names one. */
  #offering = false;
  readonly #changes = listeners();

  /**
   * @param options - `concurrency`: recordings it makes at once, `Infinity` for an engine that
   * queues for itself; `studies`: what it offers from the start. @defaultValue `{ concurrency: 1 }`
   * @throws RangeError when `concurrency` is below one; Error naming what is inconsistent in a
   * study's form.
   */
  protected constructor(
    options: { readonly concurrency?: number; readonly studies?: readonly Engine.Study[] } = {},
  ) {
    const concurrency = options.concurrency ?? 1;
    if (!(concurrency >= 1)) throw new RangeError('an engine records at least one model at once');
    this.concurrency = concurrency;
    for (const study of options.studies ?? []) this.#offer(study);
  }

  /** The studies it offers, in order: what a host lists, draws as forms, and records by name. */
  get studies(): readonly Engine.Study[] {
    return this.#offered;
  }

  /** Its studies changed: one was offered, taken over, or withdrawn. */
  on(_event: 'change', listener: () => void): () => void {
    return this.#changes.on(listener);
  }

  /**
   * The parameters `input` shows, in form order: each whose group is switched on and whose `when`
   * holds, a value left out taking its default. None for a study the engine does not offer.
   */
  shown(input: Engine.Input): readonly Engine.Parameter[] {
    const study = this.#studies.get(input.study);
    return study ? shownOf(study, input.values) : [];
  }

  /**
   * What is wrong with `input` for `model`, by parameter id, or a group's for a switch that is
   * neither on nor off; empty when nothing is. Pure and immediate, and the same on either side of
   * a port, so a form shows it as the user types. An `each` parameter may hold several values
   * here, each checked. Empty for a study the engine does not offer.
   */
  problems(model: Model, input: Engine.Input): Readonly<Record<string, string>> {
    const study = this.#studies.get(input.study);
    return study ? problemsOf(study, model, input.values, false) : {};
  }

  /**
   * Record `model` for `input`: `input` is checked at once, and the recording returned waits its
   * turn, then fills as the engine computes, holding every class of `model` that records a signal.
   * For a study, the recording's label defaults to the study's.
   *
   * @throws Refusal at the parameter to fix, or at null for a study the engine does not offer or a
   * model of another format; TypeError or RangeError for an input the engine refuses. Either comes
   * before anything is recorded.
   */
  record(
    model: Model,
    input: unknown,
    options?: { readonly id?: string; readonly label?: string },
  ): Recording;
  /**
   * Record `model` for `input` into `recorder`, such as one a transport forwards: `input` is
   * checked at once, and this resolves once the recording is complete, or rejects with why it
   * failed or stopped.
   *
   * @throws Refusal, TypeError, or RangeError for an input the engine refuses, before anything is
   * recorded.
   */
  record(model: Model, input: unknown, recorder: Engine.Recorder): Promise<void>;
  record(
    model: Model,
    input: unknown,
    into: Engine.Recorder | { readonly id?: string; readonly label?: string } = {},
  ): Recording | Promise<void> {
    const study = this.#offering ? this.#check(model, input) : null;
    const parsed = this.parse(study ? study.input : input);
    if (isRecorder(into)) return this.#take(model, parsed, into);
    const header = study && into.label === undefined ? { ...into, label: study.label } : into;
    return begin(model, header, (recorder) => this.#take(model, parsed, recorder));
  }

  /**
   * The input a saved file holds: the study it names, and its values as a form holds them. Absent
   * for an engine that reads no files.
   */
  read?(model: Model, file: Engine.File, signal?: AbortSignal): Promise<Engine.Input>;

  /**
   * Offer `study`, taking the place of any it offers with the same id; the return withdraws it.
   * What it began recording goes on. A subclass that takes studies as data may make this public.
   *
   * @throws Error naming the first thing that is inconsistent in its form.
   */
  protected offer(study: Engine.Study): () => void {
    return this.#offer(study);
  }

  /**
   * An input as this engine takes it, from a host or a peer: checked, and the engine's own. Once
   * the engine offers a study, it names one, with each shown parameter's value, null for one left
   * empty, and each switch's position: the engine's to keep.
   *
   * @throws TypeError or RangeError naming what is wrong.
   */
  protected abstract parse(input: unknown): unknown;

  /**
   * Record `model` for an input `parse` returned: declare what the recording spans, append frames
   * as they are computed, and log along the way; resolve once it is complete. Throwing fails the
   * recording; `recorder.signal` aborts when its host stops it.
   */
  protected abstract execute(
    model: Model,
    input: unknown,
    recorder: Engine.Recorder,
  ): Promise<void>;

  #offer(study: Engine.Study): () => void {
    const kept = checkStudy(study);
    this.#offering = true;
    this.#studies.set(kept.id, kept);
    this.#publish();
    return () => {
      if (this.#studies.get(kept.id) !== kept) return;
      this.#studies.delete(kept.id);
      this.#publish();
    };
  }

  #publish(): void {
    this.#offered = Object.freeze([...this.#studies.values()]);
    this.#changes.emit();
  }

  /** `input` checked against the study it names, as `parse` sees it. */
  #check(model: Model, input: unknown): { readonly label: string; readonly input: Engine.Input } {
    if (!isInput(input)) throw new TypeError('an input names a study and gives its values');
    const study = this.#studies.get(input.study);
    if (!study) throw new Refusal(`No study '${input.study}' is offered.`);
    if (study.formats && !study.formats.includes(model.format))
      throw new Refusal(
        `${study.label} records ${study.formats.join(' or ')} cases, not ${model.format}.`,
      );
    const problems = problemsOf(study, model, input.values, true);
    const [at] = Object.keys(problems);
    if (at !== undefined) throw new Refusal(problems[at]!, at);
    return {
      label: study.label,
      input: Object.freeze({ study: study.id, values: valuesOf(study, input.values) }),
    };
  }

  /** Execute `parsed` into `recorder` in turn: at once while a turn is free, else in queue order. */
  #take(model: Model, parsed: unknown, recorder: Engine.Recorder): Promise<void> {
    const { signal } = recorder;
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        this.#running++;
        recorder.start();
        let running: Promise<void>;
        try {
          running = this.execute(model, parsed, recorder);
        } catch (error) {
          running = Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        void running.then(resolve, reject).finally(() => {
          this.#running--;
          this.#next();
        });
      };
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      if (this.#running < this.concurrency) {
        start();
        return;
      }
      const leave = (): void => {
        const at = this.#waiting.indexOf(waiting);
        if (at < 0) return;
        this.#waiting.splice(at, 1);
        this.#tell();
        reject(abortReason(signal));
      };
      const waiting: Waiting = {
        recorder,
        start: () => {
          signal.removeEventListener('abort', leave);
          start();
        },
        leave,
      };
      signal.addEventListener('abort', leave, { once: true });
      this.#waiting.push(waiting);
      this.#tell();
    });
  }

  /** Start the next recording waiting, if a turn is free. */
  #next(): void {
    if (this.#running >= this.concurrency) return;
    const waiting = this.#waiting.shift();
    if (!waiting) return;
    this.#tell();
    waiting.start();
  }

  /** Tell every waiting recording how many wait before it. */
  #tell(): void {
    this.#waiting.forEach((waiting, ahead) => waiting.recorder.wait(ahead));
  }
}

/** What an engine writes through, and the studies it offers. */
export declare namespace Engine {
  /**
   * A recording as its engine writes it. Every call before the engine resolves is in order; once
   * it ends, an append throws and the rest do nothing.
   */
  interface Recorder {
    /** Aborts when its host stops the recording. */
    readonly signal: AbortSignal;
    /**
     * Resolves once the recording can take more frames: await it between appends to go at the
     * pace of whoever reads them, such as a port. A recording in memory is always ready.
     */
    readonly ready: Promise<void>;
    /**
     * What the recording spans and the frames it expects, as soon as the engine knows; a later
     * call replaces what it gives.
     *
     * @throws RangeError or TypeError for a bad span or frame count.
     */
    declare(extent: {
      readonly span?: Domain | null;
      readonly expectedFrames?: number | null;
    }): void;
    /** It waits behind `ahead` others: its engine's queue, or the one its engine reports. */
    wait(ahead: number): void;
    /** It is computing. */
    start(): void;
    /**
     * Commit frames for every recorded class at once: `values[classId]` holds that class's
     * recorded signals frame-major, `(frame * signals + signal) * elements + element`, in the
     * order the class declares them; a class left out reads NaN over them. The recorder takes the
     * buffers: never touch them again.
     *
     * @throws TypeError or RangeError when the frames are invalid, and nothing changes; Error once
     * the recording has ended.
     */
    append(time: Float64Array, values: Readonly<Record<string, Float32Array | Float64Array>>): void;
    /** A line for the recording's log. */
    log(level: 'info' | 'warn' | 'error', message: string): void;
  }
  /**
   * A study an engine offers: what a host lists, and the form it fills to record one. Plain data,
   * so it crosses a port as it is.
   */
  interface Study {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    /** The formats whose models it records, such as `gridkit`; any format when absent. */
    readonly formats?: readonly string[];
    readonly parameters: readonly Parameter[];
    readonly groups?: readonly Group[];
  }
  /**
   * Parameters shown together. One with a `switch` turns on and off as one, and `values[id]` says
   * which.
   */
  interface Group {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    /** A switch, and where it starts; while off, its parameters neither show nor count. */
    readonly switch?: 'on' | 'off';
  }
  /** One value a study asks for, in a column's words, `id`, `label`, `unit`, and `group`. */
  type Parameter = {
    /** Unique among the study's parameters and groups. */
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    /** The group it shows in, by id. */
    readonly group?: string;
    /** What it holds until given another: a value left out takes it. */
    readonly default?: Value;
    /** It may be left empty; `placeholder` says what that means. */
    readonly optional?: boolean;
    readonly placeholder?: string;
    /** It takes a list: any kind but a flag. */
    readonly multiple?: boolean;
    /**
     * A host takes several values and records once for each, each input holding one; left empty
     * or hidden, once. One parameter of a study at most.
     */
    readonly each?: boolean;
    /**
     * It shows, and counts, only while each parameter named, one choice, text, or flag, shows and
     * holds this value, or one of these.
     */
    readonly when?: Readonly<Record<string, string | boolean | readonly string[]>>;
  } & (
    | {
        readonly kind: 'number';
        readonly unit?: string;
        readonly integer?: boolean;
        /** At least. */
        readonly min?: number;
        /** At most. */
        readonly max?: number;
        /** Greater than: `above: 0` is positive. */
        readonly above?: number;
        /** Less than. */
        readonly below?: number;
      }
    | { readonly kind: 'text' }
    | { readonly kind: 'flag' }
    | {
        readonly kind: 'choice';
        readonly choices: readonly { readonly id: string; readonly label: string }[];
      }
    /** Elements of one class: a host picks among `model.grid(classId)`, or takes the selection. */
    | { readonly kind: 'element'; readonly classId: string }
    /** A file a user gives; `extensions`, such as `csv`, are what its name may end in. */
    | { readonly kind: 'file'; readonly extensions?: readonly string[] }
  );
  /** A file a user gives, whole. */
  interface File {
    readonly name: string;
    readonly bytes: Uint8Array;
  }
  /**
   * A value by kind: a number, text, a flag, a choice's id, an element, or a file; a list where
   * `multiple` or `each`; null leaves a parameter empty.
   */
  type Value =
    | number
    | string
    | boolean
    | Model.Element
    | File
    | readonly (number | string | boolean | Model.Element | File)[]
    | null;
  /** Each parameter's value by id, and each switched group's position by its id. */
  type Values = Readonly<Record<string, Value>>;
  /** What a host records: the study it names, and its values. */
  interface Input {
    readonly study: string;
    readonly values: Values;
  }
}

/** Whether `into` is a recorder to write through, rather than a recording's header. */
function isRecorder(into: object): into is Engine.Recorder {
  return typeof (into as Partial<Engine.Recorder>).append === 'function';
}

/** Whether `value` names a study and gives its values. */
function isInput(value: unknown): value is Engine.Input {
  if (typeof value !== 'object' || value === null) return false;
  const { study, values } = value as Partial<Engine.Input>;
  return (
    typeof study === 'string' &&
    typeof values === 'object' &&
    values !== null &&
    !Array.isArray(values)
  );
}

/** Why `signal` aborted, as an error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The recording was stopped.', 'AbortError');
}
