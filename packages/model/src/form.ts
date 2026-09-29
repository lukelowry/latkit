/**
 * A study's form: checked once when an engine offers it, then asked what shows, what is wrong,
 * and the values `parse` sees. It is pure, so an engine connected across a port answers the same.
 */

import type { Engine } from './engine.js';
import { formatNumber } from './grid.js';
import type { Model } from './model.js';

/** One value of a parameter; a list holds several. */
type Entry = number | string | boolean | Model.Element | Engine.File;

const KINDS: ReadonlySet<unknown> = new Set<Engine.Parameter['kind']>([
  'number',
  'text',
  'flag',
  'choice',
  'element',
  'file',
]);

const BOUNDS = ['min', 'max', 'above', 'below'] as const;

/**
 * `given` as an engine keeps it: a frozen copy of its own, checked once.
 *
 * @throws Error naming the first thing that is inconsistent.
 */
export function checkStudy(given: Engine.Study): Engine.Study {
  let study: unknown;
  try {
    study = structuredClone(given);
  } catch {
    throw new Error('a study must be plain data');
  }
  if (!isRecord(study)) throw new Error('a study must be an object');
  const at = `study '${name(study.id, 'study id')}'`;
  if (
    typeof study.label !== 'string' ||
    !optional(study.description, isString) ||
    !optional(study.formats, (formats) => Array.isArray(formats) && formats.every(isName)) ||
    !optional(study.groups, Array.isArray) ||
    !Array.isArray(study.parameters)
  )
    throw new Error(`${at} is malformed`);
  const ids = new Set<string>();
  const claim = (id: unknown, what: string): string => {
    const claimed = name(id, `${at} ${what} id`);
    if (ids.has(claimed)) throw new Error(`${at} repeats the id '${claimed}'`);
    ids.add(claimed);
    return claimed;
  };
  const groups = new Set<string>();
  for (const group of (study.groups ?? []) as unknown[]) {
    if (!isRecord(group)) throw new Error(`${at} has a malformed group`);
    const id = claim(group.id, 'group');
    if (
      typeof group.label !== 'string' ||
      !optional(group.description, isString) ||
      !optional(group.switch, (position) => position === 'on' || position === 'off')
    )
      throw new Error(`${at} group '${id}' is malformed`);
    groups.add(id);
  }
  const parameters = new Map<string, Engine.Parameter>();
  for (const parameter of study.parameters as unknown[]) {
    if (!isRecord(parameter)) throw new Error(`${at} has a malformed parameter`);
    const id = claim(parameter.id, 'parameter');
    const where = `${at} parameter '${id}'`;
    if (!wellFormed(parameter)) throw new Error(`${where} is malformed`);
    const declared = parameter as unknown as Engine.Parameter;
    if (declared.group !== undefined && !groups.has(declared.group))
      throw new Error(`${where} names no group '${declared.group}'`);
    if (declared.kind === 'flag' && declared.multiple)
      throw new Error(`${where} is a flag, which takes no list`);
    if (declared.multiple && declared.each) throw new Error(`${where} is both multiple and each`);
    if (declared.default !== undefined) {
      if (declared.kind === 'element')
        throw new Error(`${where} is an element, which has no default`);
      if (empty(declared.default)) throw new Error(`${where} has an empty default`);
      const problem = problemOf(declared, declared.default, null, false);
      if (problem !== null) throw new Error(`${where} default: ${problem}`);
    }
    parameters.set(id, declared);
  }
  if ([...parameters.values()].filter((parameter) => parameter.each).length > 1)
    throw new Error(`${at} records once for each value of more than one parameter`);
  for (const parameter of parameters.values()) checkWhen(at, parameter, parameters);
  const waiting = new Set<string>();
  const settled = new Set<string>();
  const visit = (parameter: Engine.Parameter): void => {
    if (settled.has(parameter.id)) return;
    if (waiting.has(parameter.id))
      throw new Error(`${at} parameter '${parameter.id}' waits on itself`);
    waiting.add(parameter.id);
    for (const id of Object.keys(parameter.when ?? {})) visit(parameters.get(id)!);
    waiting.delete(parameter.id);
    settled.add(parameter.id);
  };
  for (const parameter of parameters.values()) visit(parameter);
  return freeze(study) as unknown as Engine.Study;
}

/** The parameters `values` show, in form order. */
export function shownOf(study: Engine.Study, values: Engine.Values): readonly Engine.Parameter[] {
  return study.parameters.filter(showing(study, held(study, values)));
}

/**
 * What is wrong with `values` for `model`, by parameter id, or a group's for a switch that is
 * neither on nor off. `one` holds an `each` parameter to one value, as a recorded input does; a
 * form holds several.
 */
export function problemsOf(
  study: Engine.Study,
  model: Model,
  values: Engine.Values,
  one: boolean,
): Record<string, string> {
  const form = held(study, values);
  const problems: Record<string, string> = {};
  for (const group of study.groups ?? [])
    if (group.switch !== undefined && typeof form[group.id] !== 'boolean')
      problems[group.id] = `${group.label} must be on or off.`;
  const shows = showing(study, form);
  for (const parameter of study.parameters) {
    if (!shows(parameter)) continue;
    const problem = problemOf(parameter, form[parameter.id], model, one);
    if (problem !== null) problems[parameter.id] = problem;
  }
  return problems;
}

/**
 * The values `parse` sees: each shown parameter's, null for one left empty, and each switch's
 * position, copied so the caller's own may change.
 */
export function valuesOf(study: Engine.Study, values: Engine.Values): Engine.Values {
  const form = held(study, values);
  const shows = showing(study, form);
  const seen: Record<string, Engine.Value> = {};
  for (const group of study.groups ?? [])
    if (group.switch !== undefined) seen[group.id] = form[group.id] as boolean;
  for (const parameter of study.parameters) {
    if (!shows(parameter)) continue;
    const value = form[parameter.id];
    seen[parameter.id] = empty(value) ? null : copy(value as Engine.Value);
  }
  return Object.freeze(seen);
}

/** Each value a form holds, the one given or else its default, and each switch's position. */
function held(study: Engine.Study, values: Engine.Values): Readonly<Record<string, unknown>> {
  const given = (id: string): unknown => (Object.hasOwn(values, id) ? values[id] : undefined);
  const form: Record<string, unknown> = {};
  for (const group of study.groups ?? [])
    if (group.switch !== undefined) form[group.id] = given(group.id) ?? group.switch === 'on';
  for (const parameter of study.parameters) {
    const value = given(parameter.id);
    form[parameter.id] = value === undefined ? parameter.default : value;
  }
  return form;
}

/**
 * Whether a parameter shows: its group, if switched, is on, and each parameter its `when` names
 * shows and holds a value it wants.
 */
function showing(
  study: Engine.Study,
  form: Readonly<Record<string, unknown>>,
): (parameter: Engine.Parameter) => boolean {
  const switched = new Set(
    (study.groups ?? []).filter((group) => group.switch !== undefined).map((group) => group.id),
  );
  const byId = new Map(study.parameters.map((parameter) => [parameter.id, parameter]));
  const known = new Map<string, boolean>();
  const shows = (parameter: Engine.Parameter): boolean => {
    let result = known.get(parameter.id);
    if (result !== undefined) return result;
    result =
      parameter.group === undefined ||
      !switched.has(parameter.group) ||
      form[parameter.group] === true;
    for (const [id, wanted] of Object.entries(parameter.when ?? {})) {
      if (!result) break;
      result =
        shows(byId.get(id)!) &&
        (typeof wanted === 'object' ? wanted.includes(form[id] as string) : form[id] === wanted);
    }
    known.set(parameter.id, result);
    return result;
  };
  return shows;
}

/** What is wrong with `value` for `parameter`, or null; `model` null checks no element's range. */
function problemOf(
  parameter: Engine.Parameter,
  value: unknown,
  model: Model | null,
  one: boolean,
): string | null {
  const { label } = parameter;
  if (empty(value)) return parameter.optional ? null : `${label} is required.`;
  if (Array.isArray(value)) {
    if (parameter.each && one) return `${label} takes one value per recording.`;
    if (!parameter.multiple && !parameter.each) return `${label} takes one value.`;
    for (const entry of value as readonly unknown[]) {
      const problem = entryProblem(parameter, entry, model);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (parameter.multiple) return `${label} takes a list.`;
  return entryProblem(parameter, value, model);
}

function entryProblem(
  parameter: Engine.Parameter,
  value: unknown,
  model: Model | null,
): string | null {
  const { label } = parameter;
  switch (parameter.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number.`;
      if (parameter.integer && !Number.isSafeInteger(value))
        return `${label} must be a whole number.`;
      if (parameter.min !== undefined && value < parameter.min)
        return `${label} must be at least ${formatNumber(parameter.min)}.`;
      if (parameter.above !== undefined && value <= parameter.above)
        return `${label} must be greater than ${formatNumber(parameter.above)}.`;
      if (parameter.max !== undefined && value > parameter.max)
        return `${label} must be at most ${formatNumber(parameter.max)}.`;
      if (parameter.below !== undefined && value >= parameter.below)
        return `${label} must be less than ${formatNumber(parameter.below)}.`;
      return null;
    }
    case 'text':
      return typeof value === 'string' ? null : `${label} must be text.`;
    case 'flag':
      return typeof value === 'boolean' ? null : `${label} must be on or off.`;
    case 'choice':
      return parameter.choices.some((choice) => choice.id === value)
        ? null
        : `${label} must be ${either(parameter.choices.map((choice) => choice.label))}.`;
    case 'element': {
      const spec = model?.class(parameter.classId);
      const fits =
        isElement(value) &&
        value.classId === parameter.classId &&
        (model === null || (spec !== undefined && value.index < spec.count));
      return fits
        ? null
        : `${label} must be one of the case's ${spec?.label ?? parameter.classId} elements.`;
    }
    case 'file': {
      if (!isFile(value)) return `${label} must be a file.`;
      const extensions = (parameter.extensions ?? []).map((extension) =>
        extension.replace(/^\./, '').toLowerCase(),
      );
      const named = value.name.toLowerCase();
      return extensions.length === 0 ||
        extensions.some((extension) => named.endsWith(`.${extension}`))
        ? null
        : `${label} must be a ${extensions.map((extension) => `.${extension}`).join(' or ')} file.`;
    }
  }
}

/** Whether a parameter's fields have the types its kind gives them. */
function wellFormed(parameter: Readonly<Record<string, unknown>>): boolean {
  if (
    !KINDS.has(parameter.kind) ||
    typeof parameter.label !== 'string' ||
    !optional(parameter.description, isString) ||
    !optional(parameter.group, isString) ||
    !optional(parameter.optional, isBoolean) ||
    !optional(parameter.placeholder, isString) ||
    !optional(parameter.multiple, isBoolean) ||
    !optional(parameter.each, isBoolean) ||
    !optional(parameter.when, isRecord)
  )
    return false;
  switch (parameter.kind) {
    case 'number':
      return (
        optional(parameter.unit, isString) &&
        optional(parameter.integer, isBoolean) &&
        BOUNDS.every((bound) => optional(parameter[bound], Number.isFinite))
      );
    case 'choice': {
      const { choices } = parameter;
      if (!Array.isArray(choices) || choices.length === 0) return false;
      const ids = new Set<unknown>();
      for (const choice of choices as unknown[]) {
        if (!isRecord(choice) || !isName(choice.id) || typeof choice.label !== 'string')
          return false;
        if (ids.has(choice.id)) return false;
        ids.add(choice.id);
      }
      return true;
    }
    case 'element':
      return isName(parameter.classId);
    case 'file':
      return optional(
        parameter.extensions,
        (extensions) => Array.isArray(extensions) && extensions.every(isName),
      );
    default:
      return true;
  }
}

/**
 * `parameter`'s `when`: other parameters of its study, each one choice, text, or flag, and values
 * they can hold.
 */
function checkWhen(
  at: string,
  parameter: Engine.Parameter,
  parameters: ReadonlyMap<string, Engine.Parameter>,
): void {
  for (const [id, wanted] of Object.entries(parameter.when ?? {})) {
    const where = `${at} parameter '${parameter.id}' when '${id}'`;
    const other = parameters.get(id);
    if (other === undefined || other === parameter)
      throw new Error(`${where} names no other parameter`);
    if (
      other.multiple ||
      other.each ||
      (other.kind !== 'choice' && other.kind !== 'text' && other.kind !== 'flag')
    )
      throw new Error(`${where} names a parameter that is not one choice, text, or flag`);
    const values: readonly unknown[] = Array.isArray(wanted)
      ? (wanted as readonly unknown[])
      : [wanted];
    const holds = (value: unknown): boolean =>
      other.kind === 'choice'
        ? other.choices.some((choice) => choice.id === value)
        : typeof value === 'string';
    const fits =
      other.kind === 'flag'
        ? typeof wanted === 'boolean'
        : values.length > 0 && values.every(holds);
    if (!fits) throw new Error(`${where} wants a value it cannot hold`);
  }
}

/**
 * A value `parse` keeps: lists and elements copied, so the caller's own may change; a file is the
 * handle it reads through.
 */
function copy(value: Engine.Value): Engine.Value {
  if (Array.isArray(value)) return Object.freeze((value as readonly Entry[]).map(copyEntry));
  return copyEntry(value as Entry);
}

function copyEntry(value: Entry): Entry {
  return isElement(value) ? Object.freeze({ classId: value.classId, index: value.index }) : value;
}

/** Whether `value` leaves a parameter empty: absent, null, empty text, or an empty list. */
function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** `labels` as one of them: `A or B`, `A, B, or C`. */
function either(labels: readonly string[]): string {
  return labels.length <= 2
    ? labels.join(' or ')
    : `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)!}`;
}

/** `value` and everything in it, frozen; typed arrays stay as they are. */
function freeze(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): boolean {
  return typeof value === 'string';
}

function isBoolean(value: unknown): boolean {
  return typeof value === 'boolean';
}

function isName(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function isElement(value: unknown): value is Model.Element {
  return (
    isRecord(value) &&
    typeof value.classId === 'string' &&
    Number.isSafeInteger(value.index) &&
    (value.index as number) >= 0
  );
}

function isFile(value: unknown): value is Engine.File {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.slice === 'function' &&
    typeof value.stream === 'function'
  );
}

function optional(value: unknown, test: (value: unknown) => boolean): boolean {
  return value === undefined || test(value);
}

function name(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} must be non-empty`);
  return value;
}
