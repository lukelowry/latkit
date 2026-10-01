import { failure } from './errors.js';
export type Kind = 'model' | 'recording' | 'queryable' | 'stream';
/** The metadata each kind publishes, the only state that crosses with it. */
export const stateKeys: Record<Exclude<Kind, 'stream'>, readonly string[]> = {
  model: ['name', 'version', 'routines'],
  recording: ['version', 'status', 'frames', 'range', 'progress', 'diagnostics'],
  queryable: ['version'],
};
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('invalid-input', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : record(value);
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length)
    throw failure('invalid-input', 'Expected nonempty text.');
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw failure('invalid-input', 'Expected an array.');
  return value as unknown[];
}
export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function validateState(kind: Kind, state: Record<string, unknown>): void {
  if (kind === 'stream') return;
  if (Object.keys(state).some((key) => !stateKeys[kind].includes(key)))
    throw failure('invalid-input', 'Unknown state property.');
  text(state.version);
  if (kind === 'model') {
    text(state.name);
    for (const value of array(state.routines)) {
      const routine = record(value);
      text(routine.id);
      text(routine.label);
      array(routine.parameters);
      if (routine.records !== undefined && typeof routine.records !== 'boolean')
        throw failure('invalid-input');
    }
  }
  if (kind === 'recording') {
    if (!['idle', 'running', 'complete', 'cancelled', 'failed'].includes(String(state.status)))
      throw failure('invalid-input');
    if (!integer(state.frames)) throw failure('invalid-input');
    if (state.range !== null) {
      const range = array(state.range);
      if (
        range.length !== 2 ||
        !range.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
        Number(range[0]) > Number(range[1])
      )
        throw failure('invalid-input');
    }
    if (
      state.progress !== null &&
      (typeof state.progress !== 'number' || !(state.progress >= 0 && state.progress <= 1))
    )
      throw failure('invalid-input');
    for (const value of array(state.diagnostics)) {
      const diagnostic = record(value);
      text(diagnostic.code);
      if (typeof diagnostic.message !== 'string') throw failure('invalid-input');
      if (!['info', 'warning', 'error'].includes(String(diagnostic.severity)))
        throw failure('invalid-input');
    }
  }
}
