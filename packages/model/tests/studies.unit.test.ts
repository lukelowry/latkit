import { describe, expect, it, vi } from 'vitest';

import { Engine, Refusal } from '../src/index.js';
import { ended, Sample, sampleData, sampleModel } from './fixture.js';

/** An engine a test offers studies on, noting each input `parse` sees; `gate` holds recordings. */
class Studied extends Engine {
  readonly parsed: unknown[] = [];
  readonly #gate: Promise<void>;

  constructor(studies: readonly Engine.Study[] = [], gate: Promise<void> = Promise.resolve()) {
    super({ studies });
    this.#gate = gate;
  }

  override offer(study: Engine.Study): () => void {
    return super.offer(study);
  }

  protected parse(input: unknown): unknown {
    this.parsed.push(input);
    return input;
  }

  protected execute(): Promise<void> {
    return this.#gate;
  }
}

const SIMULATION: Engine.Study = {
  id: 'simulation',
  label: 'Simulation',
  formats: ['test'],
  groups: [
    { id: 'fault', label: 'Fault', switch: 'off' },
    { id: 'tolerances', label: 'Tolerances', switch: 'on' },
  ],
  parameters: [
    { id: 'tmax', kind: 'number', label: 'End time', unit: 's', above: 0, default: 10 },
    {
      id: 'steps',
      kind: 'number',
      label: 'Steps',
      integer: true,
      min: 1,
      max: 100,
      optional: true,
    },
    { id: 'bus', group: 'fault', kind: 'element', classId: 'bus', label: 'Bus' },
    { id: 'duration', group: 'fault', kind: 'number', label: 'Duration', min: 0, default: 0.1 },
    {
      id: 'rtol',
      group: 'tolerances',
      kind: 'number',
      label: 'Relative tolerance',
      above: 0,
      below: 1,
      optional: true,
      placeholder: '1e-3',
    },
    {
      id: 'measure',
      kind: 'choice',
      label: 'Measure',
      default: 'relative',
      choices: [
        { id: 'relative', label: 'Relative' },
        { id: 'absolute', label: 'Absolute' },
      ],
    },
    {
      id: 'floor',
      kind: 'number',
      label: 'Floor',
      min: 0,
      optional: true,
      when: { measure: 'relative' },
    },
    { id: 'reference', kind: 'file', label: 'Reference', extensions: ['csv'], optional: true },
    { id: 'note', kind: 'text', label: 'Note', optional: true },
    { id: 'verbose', kind: 'flag', label: 'Verbose', default: false },
  ],
};

const CONTINGENCIES: Engine.Study = {
  id: 'contingencies',
  label: 'Contingencies',
  parameters: [
    { id: 'tmax', kind: 'number', label: 'End time', above: 0, default: 10 },
    { id: 'bus', kind: 'element', classId: 'bus', label: 'Bus', each: true },
  ],
};

/** What `action` throws. */
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('nothing was thrown');
}

describe('engine studies', () => {
  it('offers its studies in order, takes one over in place, and withdraws only its own', () => {
    const engine = new Studied([SIMULATION]);
    const heard = vi.fn();
    engine.on('change', heard);
    const withdraw = engine.offer(CONTINGENCIES);
    expect(engine.studies.map((study) => study.id)).toEqual(['simulation', 'contingencies']);
    const before = engine.studies;
    const first = engine.offer({ ...SIMULATION, label: 'Transient' });
    const second = engine.offer({ ...SIMULATION, label: 'Dynamic' });
    expect(engine.studies.map((study) => study.label)).toEqual(['Dynamic', 'Contingencies']);
    expect(engine.studies).not.toBe(before);
    first();
    expect(engine.studies).toHaveLength(2);
    withdraw();
    withdraw();
    second();
    expect(engine.studies).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(5);
  });

  it('keeps a frozen copy of each study, whatever becomes of the one it was given', () => {
    const given = structuredClone(CONTINGENCIES) as { label: string };
    const engine = new Studied([given as Engine.Study]);
    given.label = 'Changed';
    const [kept] = engine.studies;
    expect(kept!.label).toBe('Contingencies');
    expect(Object.isFrozen(engine.studies)).toBe(true);
    expect(Object.isFrozen(kept!.parameters[1])).toBe(true);
  });

  it('refuses a form that is inconsistent, naming what', () => {
    const study = (parameters: readonly unknown[], extra: object = {}): Engine.Study =>
      ({ id: 's', label: 'S', parameters, ...extra }) as unknown as Engine.Study;
    const cases: [Engine.Study, RegExp][] = [
      [study([], { id: '' }), /study id must be non-empty/],
      [study([], { label: 3 }), /study 's' is malformed/],
      [
        study([
          { id: 'a', kind: 'number', label: 'A' },
          { id: 'a', kind: 'text', label: 'A' },
        ]),
        /repeats the id 'a'/,
      ],
      [
        study([{ id: 'g', kind: 'text', label: 'G' }], { groups: [{ id: 'g', label: 'G' }] }),
        /repeats the id 'g'/,
      ],
      [study([], { groups: [{ id: 'g', label: 'G', switch: 'up' }] }), /group 'g' is malformed/],
      [
        study([{ id: 'a', kind: 'number', label: 'A', group: 'none' }]),
        /parameter 'a' names no group 'none'/,
      ],
      [study([{ id: 'a', kind: 'date', label: 'A' }]), /parameter 'a' is malformed/],
      [study([{ id: 'a', kind: 'choice', label: 'A', choices: [] }]), /parameter 'a' is malformed/],
      [study([{ id: 'a', kind: 'number', label: 'A', min: Infinity }]), /is malformed/],
      [study([{ id: 'a', kind: 'element', label: 'A' }]), /is malformed/],
      [
        study([{ id: 'a', kind: 'flag', label: 'A', multiple: true }]),
        /a flag, which takes no list/,
      ],
      [
        study([{ id: 'a', kind: 'number', label: 'A', multiple: true, each: true }]),
        /both multiple and each/,
      ],
      [
        study([
          { id: 'a', kind: 'number', label: 'A', each: true },
          { id: 'b', kind: 'number', label: 'B', each: true },
        ]),
        /more than one parameter/,
      ],
      [
        study([
          {
            id: 'a',
            kind: 'element',
            label: 'A',
            classId: 'bus',
            default: { classId: 'bus', index: 0 },
          },
        ]),
        /an element, which has no default/,
      ],
      [
        study([{ id: 'a', kind: 'number', label: 'A', above: 0, default: 0 }]),
        /default: A must be greater than 0\./,
      ],
      [study([{ id: 'a', kind: 'text', label: 'A', default: '' }]), /an empty default/],
      [
        study([{ id: 'a', kind: 'number', label: 'A', when: { b: 'x' } }]),
        /when 'b' names no other parameter/,
      ],
      [
        study([
          { id: 'a', kind: 'number', label: 'A' },
          { id: 'b', kind: 'text', label: 'B', when: { a: 'x' } },
        ]),
        /not one choice, text, or flag/,
      ],
      [
        study([
          { id: 'a', kind: 'choice', label: 'A', choices: [{ id: 'x', label: 'X' }] },
          { id: 'b', kind: 'text', label: 'B', when: { a: ['x', 'y'] } },
        ]),
        /wants a value it cannot hold/,
      ],
      [
        study([
          { id: 'a', kind: 'flag', label: 'A', when: { b: true } },
          { id: 'b', kind: 'flag', label: 'B', when: { a: true } },
        ]),
        /waits on itself/,
      ],
      [study([{ id: 'a', kind: 'text', label: 'A', hint: () => 'no' }]), /plain data/],
    ];
    for (const [given, message] of cases) expect(() => new Studied([given])).toThrow(message);
    expect(() => new Studied().offer(study([]))).not.toThrow();
  });

  it('shows the parameters an input switches on and its conditions allow, left-out values taking their defaults', () => {
    const engine = new Studied([
      SIMULATION,
      {
        id: 'chain',
        label: 'Chain',
        groups: [{ id: 'g', label: 'G', switch: 'on' }],
        parameters: [
          {
            id: 'method',
            group: 'g',
            kind: 'choice',
            label: 'Method',
            default: 'a',
            choices: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
              { id: 'c', label: 'C' },
            ],
          },
          {
            id: 'order',
            kind: 'text',
            label: 'Order',
            optional: true,
            when: { method: ['b', 'c'] },
          },
          { id: 'detail', kind: 'text', label: 'Detail', optional: true, when: { order: 'high' } },
        ],
      },
    ]);
    const shown = (study: string, values: Engine.Values): string[] =>
      engine.shown({ study, values }).map((parameter) => parameter.id);
    expect(shown('simulation', {})).toEqual([
      'tmax',
      'steps',
      'rtol',
      'measure',
      'floor',
      'reference',
      'note',
      'verbose',
    ]);
    expect(shown('simulation', { fault: true, tolerances: false, measure: 'absolute' })).toEqual([
      'tmax',
      'steps',
      'bus',
      'duration',
      'measure',
      'reference',
      'note',
      'verbose',
    ]);
    expect(shown('chain', {})).toEqual(['method']);
    expect(shown('chain', { method: 'c', order: 'high' })).toEqual(['method', 'order', 'detail']);
    // A condition on a parameter that does not show does not hold.
    expect(shown('chain', { g: false, method: 'c', order: 'high' })).toEqual([]);
    expect(shown('none', {})).toEqual([]);
  });

  it('says what is wrong with each parameter that shows, by id', () => {
    const engine = new Studied([SIMULATION]);
    const model = sampleModel();
    const problems = (values: Engine.Values) =>
      engine.problems(model, { study: 'simulation', values });
    const file = (name: string) => ({ name, bytes: Uint8Array.of(1) });
    expect(problems({})).toEqual({});
    expect(problems({ tmax: null })).toEqual({ tmax: 'End time is required.' });
    expect(problems({ tmax: NaN })).toEqual({ tmax: 'End time must be a number.' });
    expect(problems({ tmax: 0 })).toEqual({ tmax: 'End time must be greater than 0.' });
    expect(problems({ steps: 1.5 })).toEqual({ steps: 'Steps must be a whole number.' });
    expect(problems({ steps: 0 })).toEqual({ steps: 'Steps must be at least 1.' });
    expect(problems({ steps: 101 })).toEqual({ steps: 'Steps must be at most 100.' });
    expect(problems({ steps: [1, 2] })).toEqual({ steps: 'Steps takes one value.' });
    expect(problems({ rtol: 1 })).toEqual({ rtol: 'Relative tolerance must be less than 1.' });
    expect(problems({ measure: 'mean' })).toEqual({
      measure: 'Measure must be Relative or Absolute.',
    });
    expect(problems({ note: 3 })).toEqual({ note: 'Note must be text.' });
    expect(problems({ verbose: 'yes' })).toEqual({ verbose: 'Verbose must be on or off.' });
    expect(problems({ reference: file('ref.txt') })).toEqual({
      reference: 'Reference must be a .csv file.',
    });
    expect(problems({ reference: file('REF.CSV') })).toEqual({});
    expect(problems({ reference: 'ref.csv' })).toEqual({ reference: 'Reference must be a file.' });
    expect(problems({ fault: true })).toEqual({ bus: 'Bus is required.' });
    for (const bus of [
      { classId: 'gen', index: 0 },
      { classId: 'bus', index: 3 },
    ])
      expect(problems({ fault: true, bus })).toEqual({
        bus: "Bus must be one of the case's Bus elements.",
      });
    expect(problems({ fault: true, bus: { classId: 'bus', index: 2 } })).toEqual({});
    expect(problems({ fault: 'on' })).toEqual({ fault: 'Fault must be on or off.' });
    // A parameter that does not show is not checked.
    expect(problems({ measure: 'absolute', floor: -1, tolerances: false, rtol: 5 })).toEqual({});
    expect(engine.problems(model, { study: 'none', values: { tmax: 0 } })).toEqual({});
  });

  it('checks each value a form holds for a list, or for a parameter recorded once for each', () => {
    const engine = new Studied([
      CONTINGENCIES,
      {
        id: 'levels',
        label: 'Levels',
        parameters: [{ id: 'level', kind: 'number', label: 'Level', multiple: true, above: 0 }],
      },
    ]);
    const model = sampleModel();
    const bus = (index: number) => ({ classId: 'bus', index });
    const problems = (study: string, values: Engine.Values) =>
      engine.problems(model, { study, values });
    expect(problems('contingencies', { bus: [bus(0), bus(2)] })).toEqual({});
    expect(problems('contingencies', { bus: bus(1) })).toEqual({});
    expect(problems('contingencies', { bus: [bus(0), bus(9)] })).toEqual({
      bus: "Bus must be one of the case's Bus elements.",
    });
    expect(problems('contingencies', { bus: [] })).toEqual({ bus: 'Bus is required.' });
    expect(problems('levels', { level: [1, 2] })).toEqual({});
    expect(problems('levels', { level: 1 })).toEqual({ level: 'Level takes a list.' });
    expect(problems('levels', { level: [1, -1] })).toEqual({
      level: 'Level must be greater than 0.',
    });
  });

  it('refuses an input before anything is recorded, at the parameter to fix', () => {
    const engine = new Studied([SIMULATION, CONTINGENCIES]);
    const model = sampleModel();
    const record = (input: unknown) => () => engine.record(model, input);
    expect(thrown(record({ study: 'simulation', values: { tmax: -1 } }))).toMatchObject({
      name: 'Refusal',
      at: 'tmax',
      message: 'End time must be greater than 0.',
    });
    expect(thrown(record({ study: 'nothing', values: {} }))).toMatchObject({
      name: 'Refusal',
      at: null,
      message: "No study 'nothing' is offered.",
    });
    expect(
      thrown(record({ study: 'contingencies', values: { bus: [{ classId: 'bus', index: 0 }] } })),
    ).toMatchObject({ at: 'bus', message: 'Bus takes one value per recording.' });
    const other = new Sample({ description: { ...sampleData(), format: 'other' } });
    expect(thrown(() => engine.record(other, { study: 'simulation', values: {} }))).toMatchObject({
      at: null,
      message: 'Simulation records test cases, not other.',
    });
    expect(record(5)).toThrow(TypeError);
    expect(record({ study: 'simulation' })).toThrow(TypeError);
    const recorder: Engine.Recorder = {
      signal: new AbortController().signal,
      ready: Promise.resolve(),
      declare() {},
      wait() {},
      start() {},
      append() {},
      log() {},
    };
    expect(() =>
      engine.record(model, { study: 'simulation', values: { tmax: 0 } }, recorder),
    ).toThrow(Refusal);
    expect(engine.parsed).toEqual([]);
  });

  it('hands parse the values that show, defaults filled and null for one left empty, as its own', () => {
    const engine = new Studied([SIMULATION]);
    const model = sampleModel();
    const bus = { classId: 'bus', index: 1 };
    const recording = engine.record(model, {
      study: 'simulation',
      values: { fault: true, bus, steps: null, measure: 'absolute', floor: 3, extra: 'dropped' },
    });
    const [parsed] = engine.parsed as Engine.Input[];
    expect(parsed).toEqual({
      study: 'simulation',
      values: {
        fault: true,
        tolerances: true,
        tmax: 10,
        steps: null,
        bus: { classId: 'bus', index: 1 },
        duration: 0.1,
        rtol: null,
        measure: 'absolute',
        reference: null,
        note: null,
        verbose: false,
      },
    });
    bus.index = 2;
    expect(parsed!.values['bus']).toEqual({ classId: 'bus', index: 1 });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.values)).toBe(true);
    expect(recording.label).toBe('Simulation');
    expect(engine.record(model, parsed, { label: 'Again' }).label).toBe('Again');
    // Checked again, as a served engine checks what a peer checked, it is the same.
    expect(engine.parsed[1]).toEqual(parsed);
  });

  it('goes on recording a study it withdrew, and records it no more', async () => {
    let open!: () => void;
    const engine = new Studied([], new Promise<void>((resolve) => (open = resolve)));
    const withdraw = engine.offer(CONTINGENCIES);
    const model = sampleModel();
    const input = { study: 'contingencies', values: { bus: { classId: 'bus', index: 0 } } };
    const recording = engine.record(model, input);
    withdraw();
    expect(() => engine.record(model, input)).toThrow("No study 'contingencies' is offered.");
    open();
    await ended(recording);
    expect(recording.state.status).toBe('complete');
  });

  it('takes any input until it offers a study', () => {
    const engine = new Studied();
    engine.record(sampleModel(), 7);
    expect(engine.parsed).toEqual([7]);
    engine.offer(CONTINGENCIES)();
    expect(() => engine.record(sampleModel(), 7)).toThrow(TypeError);
  });
});
