import { failure, validateSelection } from '@latkit/model';
import type {
  Arguments,
  CommandDescription,
  FieldSelection,
  Parameter,
  Parameters,
  Schema,
  DataBatch,
} from '@latkit/model';
import { checkTree } from './frame.js';
import { integer, record, text } from './core.js';

export function definitions(
  input: unknown,
  schema: Schema,
  bound: number,
): Readonly<Record<string, CommandDescription>> {
  checkTree(input, bound);
  const commands = record(input);
  for (const [name, value] of Object.entries(commands)) {
    text(name);
    const command = record(value),
      parameters = record(command.parameters);
    if (command.label !== undefined) text(command.label);
    if (command.description !== undefined) text(command.description, 4096);
    for (const [key, definition] of Object.entries(parameters)) {
      text(key);
      const p = record(definition);
      for (const label of ['label', 'description', 'unit'])
        if (p[label] !== undefined) text(p[label], label === 'description' ? 4096 : 1024);
      if (!['number', 'text', 'boolean', 'choice', 'reference', 'file'].includes(String(p.type)))
        throw failure('invalid-input', 'Unknown parameter type.');
      for (const flag of ['optional', 'multiple', 'integer'])
        if (p[flag] !== undefined && typeof p[flag] !== 'boolean')
          throw failure('invalid-input', 'Invalid parameter flag.');
      if (
        p.type === 'number' &&
        ((p.min !== undefined && !Number.isFinite(p.min)) ||
          (p.max !== undefined && !Number.isFinite(p.max)) ||
          (typeof p.min === 'number' && typeof p.max === 'number' && p.min > p.max))
      )
        throw failure('invalid-input', 'Invalid numeric bounds.');
      if (
        p.type === 'choice' &&
        (!Array.isArray(p.choices) ||
          !p.choices.length ||
          p.choices.some((v) => typeof v !== 'string') ||
          new Set(p.choices).size !== p.choices.length)
      )
        throw failure('invalid-input', 'Invalid choices.');
      if (
        p.type === 'reference' &&
        (typeof p.to !== 'string' || !Object.hasOwn(schema.types, p.to))
      )
        throw failure('invalid-input', 'Unknown reference type.');
      if (
        p.type === 'file' &&
        p.accept !== undefined &&
        (!Array.isArray(p.accept) || p.accept.some((v) => typeof v !== 'string'))
      )
        throw failure('invalid-input', 'Invalid file accept list.');
      if (p.default !== undefined) parameter(p as unknown as Parameter, p.default, (file) => file);
    }
  }
  return commands as unknown as Readonly<Record<string, CommandDescription>>;
}
function parameter(p: Parameter, input: unknown, file: (value: unknown) => unknown): unknown {
  const scalar = (value: unknown): unknown => {
    if (p.type === 'number') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (p.integer && !Number.isSafeInteger(value)) ||
        (p.min !== undefined && value < p.min) ||
        (p.max !== undefined && value > p.max)
      )
        throw failure('invalid-input', 'Invalid numeric argument.');
    } else if (p.type === 'boolean') {
      if (typeof value !== 'boolean')
        throw failure('invalid-input', 'Expected a boolean argument.');
    } else if (p.type === 'file') {
      const result = file(value);
      if (!(result instanceof File)) throw failure('invalid-input', 'Expected a File argument.');
      if (
        p.accept?.length &&
        !p.accept.some((accept) =>
          accept.startsWith('.')
            ? result.name.toLowerCase().endsWith(accept.toLowerCase())
            : accept.endsWith('/*')
              ? result.type.startsWith(accept.slice(0, -1))
              : result.type === accept,
        )
      )
        throw failure('invalid-input', 'File type is not accepted.');
      return result;
    } else {
      if (typeof value !== 'string' || (p.type === 'reference' && !value.length))
        throw failure('invalid-input', 'Expected a string argument.');
      if (p.type === 'choice' && !p.choices.includes(value))
        throw failure('invalid-input', 'Unknown choice.');
    }
    return value;
  };
  if (p.multiple) {
    if (!Array.isArray(input)) throw failure('invalid-input', 'Expected an array argument.');
    return Object.freeze(input.map(scalar));
  }
  return scalar(input);
}
export function argumentsOf(
  parameters: Parameters,
  input: unknown,
  body?: Uint8Array,
): Arguments<Parameters> {
  const supplied = record(input),
    result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let fileBytes = 0;
  const file = (value: unknown): File => {
    if (!body) {
      if (!(value instanceof File)) throw failure('invalid-input', 'Expected a File argument.');
      return value;
    }
    const descriptor = record(value),
      name = text(descriptor.name),
      offset = integer(descriptor.offset),
      bytes = integer(descriptor.bytes);
    fileBytes += bytes;
    if (offset > body.length || bytes > body.length - offset || fileBytes > body.length)
      throw failure('resource-limit', 'File arguments exceed their body budget.');
    const mediaType =
      descriptor.mediaType === undefined || descriptor.mediaType === ''
        ? ''
        : text(descriptor.mediaType, 256);
    const lastModified = integer(descriptor.lastModified, Number.MIN_SAFE_INTEGER);
    return new File(
      [new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset + offset, bytes)],
      name,
      { type: mediaType, lastModified },
    );
  };
  for (const key of Object.keys(supplied))
    if (!Object.hasOwn(parameters, key)) throw failure('invalid-input', 'Unknown argument: ' + key);
  for (const [name, definition] of Object.entries(parameters)) {
    const value = Object.hasOwn(supplied, name)
      ? supplied[name]
      : 'default' in definition
        ? definition.default
        : undefined;
    if (value === undefined) {
      if (!definition.optional) throw failure('invalid-input', 'Missing argument: ' + name);
      result[name] = undefined;
    } else result[name] = parameter(definition, value, file);
  }
  return Object.freeze(result) as Arguments<Parameters>;
}
/** Files are bounded command attachments, not arbitrary serializable stream objects. */
export async function encodeArguments(
  parameters: Parameters,
  values: Readonly<Record<string, unknown>>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ values: Record<string, unknown>; chunks: Uint8Array[] }> {
  signal.throwIfAborted();
  let nodes = 0;
  for (const value of Object.values(values)) {
    nodes += Array.isArray(value) ? value.length + 1 : 1;
    if (nodes > 8192) throw failure('resource-limit', 'Too many command arguments.');
  }
  const checked = argumentsOf(parameters, values),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  // Preflight every file before reading any of them.
  for (const value of Object.values(checked))
    for (const item of Array.isArray(value) ? value : [value])
      if (item instanceof File) {
        bytes = Math.ceil(bytes / 8) * 8 + item.size;
        if (bytes > maxBytes)
          throw failure('resource-limit', 'Command files exceed the message bound.');
      }
  bytes = 0;
  const encode = async (value: unknown): Promise<unknown> => {
    signal.throwIfAborted();
    if (value instanceof File) {
      const offset = Math.ceil(bytes / 8) * 8;
      bytes = offset + value.size;
      const contents = await value.arrayBuffer();
      signal.throwIfAborted();
      chunks.push(new Uint8Array(contents));
      return {
        name: value.name,
        mediaType: value.type,
        lastModified: value.lastModified,
        offset,
        bytes: value.size,
      };
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await encode(item));
      return result;
    }
    return value;
  };
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(checked))
    if (value !== undefined) result[key] = await encode(value);
  return { values: result, chunks };
}
export function selections(value: unknown, schema: Schema): readonly FieldSelection[] {
  if (!Array.isArray(value) || value.length > 256)
    throw failure('invalid-input', 'Expected bounded field selections.');
  for (const item of value) {
    const selection = record(item);
    if (
      selection.rows !== undefined &&
      !['ids', 'range'].includes(String(record(selection.rows).kind))
    )
      throw failure('invalid-input', 'Remote rows must use IDs or ranges.');
    const issues = validateSelection(schema, item);
    if (issues.length) throw failure('invalid-input', issues[0].message);
  }
  return value as FieldSelection[];
}

/** Compile field demand once; each publication checks only its own column names. */
export function demanded(
  fields: readonly FieldSelection[],
): (batches: DataBatch | readonly DataBatch[]) => void {
  const selected = new Map<string, Set<string>>();
  for (const field of fields) {
    let names = selected.get(field.from);
    if (!names) selected.set(field.from, (names = new Set()));
    for (const name of field.select) names.add(name);
  }
  return (input) => {
    for (const batch of (Array.isArray(input) ? input : [input]) as readonly DataBatch[]) {
      const names = selected.get(batch.index.type);
      if (!names || Object.keys(batch.columns).some((name) => !names.has(name)))
        throw failure('invalid-input', 'Publication contains unrequested fields.');
    }
  };
}
