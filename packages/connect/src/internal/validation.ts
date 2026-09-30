import { failure } from './errors.js';
export type Kind = 'service' | 'document' | 'model' | 'recording' | 'resource' | 'stream';
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
  text(state.id);
  const allowed =
    kind === 'service'
      ? ['id', 'label', 'formats']
      : kind === 'document'
        ? ['id', 'name', 'format', 'version', 'saved']
        : kind === 'model'
          ? ['id', 'label', 'documentId', 'routines']
          : kind === 'recording'
            ? [
                'id',
                'scope',
                'documentId',
                'documentVersion',
                'status',
                'fields',
                'axis',
                'firstFrame',
                'frameCount',
                'range',
                'error',
                'version',
              ]
            : ['id', 'name', 'mediaType'];
  if (Object.keys(state).some((key) => !allowed.includes(key)))
    throw failure('invalid-input', 'Unknown state property.');
  if (kind === 'service') {
    text(state.label);
    for (const value of array(state.formats)) {
      const format = record(value);
      text(format.id);
      text(format.label);
      for (const key of ['mediaTypes', 'extensions'])
        for (const value of array(format[key])) text(value);
      for (const key of ['reads', 'writes', 'creates'])
        if (typeof format[key] !== 'boolean') throw failure('invalid-input');
    }
  }
  if (kind === 'document') {
    text(state.name);
    text(state.version);
    if (state.format !== null) text(state.format);
    if (state.saved !== null) {
      const saved = record(state.saved);
      text(saved.resource);
      text(saved.tag);
      text(saved.version);
    }
  }
  if (kind === 'model') {
    text(state.label);
    text(state.documentId);
    for (const value of array(state.routines)) {
      const routine = record(value);
      text(routine.id);
      text(routine.label);
      if (routine.mode !== 'live' && routine.mode !== 'isolated') throw failure('invalid-input');
      array(routine.parameters);
      if (routine.monitoring !== undefined)
        for (const mode of array(routine.monitoring))
          if (mode !== 'command' && (mode !== 'live' || routine.mode === 'isolated'))
            throw failure('invalid-input');
    }
  }
  if (kind === 'recording') {
    text(state.documentId);
    text(state.version);
    if (state.documentVersion !== null) text(state.documentVersion);
    if (!['armed', 'monitoring', 'stopped', 'failed', 'closed'].includes(String(state.status)))
      throw failure('invalid-input');
    if (
      !integer(state.firstFrame) ||
      !integer(state.frameCount) ||
      state.firstFrame > state.frameCount
    )
      throw failure('invalid-input');
    const scope = record(state.scope);
    if (scope.kind === 'command') text(scope.id);
    else if (scope.kind !== 'live') throw failure('invalid-input');
    if (state.fields !== null) array(state.fields);
    if (state.axis !== null) text(record(state.axis).name);
    if (state.range !== null) {
      const range = array(state.range);
      if (
        range.length !== 2 ||
        !range.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
        Number(range[0]) > Number(range[1])
      )
        throw failure('invalid-input');
    }
  }
  if (kind === 'resource') {
    if (state.name !== undefined) text(state.name);
    if (state.mediaType !== undefined) text(state.mediaType);
  }
}
