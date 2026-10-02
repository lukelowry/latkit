import type {
  Data,
  DataEvent,
  DataBatch,
  SampleBatch,
  TableData,
  ColumnPage,
} from './materialized.js';
import type { Index, RowAxis, TextColumn } from './data.js';
import type { Schema } from './schema.js';
import type { Version } from './types.js';
import { assertIndex, rowAt, rowCount } from './access.js';
import { compactRows, containsRows } from './columns.js';
import { failure } from './error.js';
import { PageAssembly, checkRows } from './assembly-pages.js';

/** Construct a complete value from disjoint batches. Never overwrites existing cells. */
export function createData<S extends Schema>(
  schema: S,
  version: Version,
  batches: readonly DataBatch[],
): Data<S> {
  return assemble(schema, version, batches);
}

/** Append new sampled observations to application-owned data. Static changes require createData.
 * Existing buffers are shared; earlier Data values remain valid. No model is contacted. */
export function appendData<S extends Schema>(
  previous: Data<S>,
  version: Version,
  batches: readonly SampleBatch[],
): Data<S> {
  return assemble(previous.schema, version, batches, previous);
}

type IdPage = { readonly rows: RowAxis; readonly column: TextColumn };
interface Draft {
  readonly prior?: TableData;
  readonly index: Index;
  rows: RowAxis;
  readonly fields: Map<string, ColumnPage[]>;
  readonly ids: IdPage[];
}

function assemble<S extends Schema>(
  schema: S,
  version: Version,
  batches: readonly DataBatch[],
  previous?: Data<S>,
): Data<S> {
  const drafts = new Map<string, Draft>();
  for (const batch of batches) {
    if ('replace' in batch)
      throw failure('invalid-input', 'Replacement operations are unsupported.');
    if (previous && batch.kind !== 'samples')
      throw failure('invalid-input', 'appendData accepts sampled observations only.');
    if (batch.kind !== 'rows' && batch.kind !== 'samples')
      throw failure('invalid-input', 'Unknown data batch kind.');
    const name = batch.index.type;
    if (!Object.hasOwn(schema.types, name)) throw failure('invalid-input', 'Unknown type: ' + name);
    let draft = drafts.get(name);
    if (!draft) {
      const prior =
        previous && Object.hasOwn(previous.tables, name) ? previous.tables[name] : undefined;
      draft = {
        prior,
        index: prior?.index ?? batch.index,
        rows: prior?.rows ?? batch.rows,
        fields: new Map(),
        ids: [],
      };
      drafts.set(name, draft);
    }
    assertIndex(draft.index, batch.index);
    draft.rows = unionRows(draft.rows, batch.rows);
    const samples =
      batch.kind === 'samples'
        ? { firstFrame: batch.firstFrame, coordinates: batch.coordinates }
        : undefined;
    for (const field of Object.keys(batch.columns)) {
      let added = draft.fields.get(field);
      if (added) {
        if (Boolean(added[0].samples) !== Boolean(samples))
          throw failure('invalid-input', 'Field shape differs from its schema: ' + field);
      } else {
        const definitions = schema.types[name].fields;
        if (
          !Object.hasOwn(definitions, field) ||
          Boolean(definitions[field].sampled) !== Boolean(samples)
        )
          throw failure('invalid-input', 'Field shape differs from its schema: ' + field);
      }
      if (samples && (!samples.coordinates.length || !rowCount(batch.rows))) continue;
      const column = batch.columns[field];
      const page: ColumnPage = samples
        ? { rows: batch.rows, column, samples }
        : { rows: batch.rows, column };
      if (!added) draft.fields.set(field, (added = []));
      added.push(page);
    }
    if (batch.kind === 'rows' && batch.ids) draft.ids.push({ rows: batch.rows, column: batch.ids });
  }
  const tables = Object.fromEntries(
    [...drafts].map(([name, draft]) => {
      const pages = new PageAssembly();
      const fields: Record<string, readonly ColumnPage[]> = {
        ...(draft.prior?.fields ??
          Object.fromEntries(
            Object.entries(schema.types[name].fields)
              .filter(([, field]) => field.sampled)
              .map(([field]) => [field, []]),
          )),
        ...Object.fromEntries(
          [...draft.fields].map(([field, added]) => [
            field,
            pages.append(draft.prior?.fields[field] ?? [], added),
          ]),
        ),
      };
      if (draft.ids.length) checkRows(draft.ids.map((page) => page.rows));
      return [
        name,
        {
          index: draft.index,
          rows: draft.rows,
          fields,
          ids: draft.ids.length ? draft.ids : (draft.prior?.ids ?? []),
        },
      ];
    }),
  );
  return { schema, version, tables: { ...previous?.tables, ...tables } };
}

function unionRows(a: TableData['rows'], b: TableData['rows']): TableData['rows'] {
  if (containsRows(a, b)) return a;
  if (containsRows(b, a)) return b;
  if (
    a.kind === 'range' &&
    b.kind === 'range' &&
    a.offset <= b.offset + b.count &&
    b.offset <= a.offset + a.count
  ) {
    const offset = Math.min(a.offset, b.offset);
    return {
      kind: 'range',
      offset,
      count: Math.max(a.offset + a.count, b.offset + b.count) - offset,
    };
  }
  const values = new Set<number>();
  for (const rows of [a, b]) for (let i = 0; i < rowCount(rows); i++) values.add(rowAt(rows, i));
  return compactRows([...values].sort((x, y) => x - y));
}

/** Assemble each transaction independently. No history, replay or command lifecycle. */
export async function* transactions<S extends Schema>(
  schema: S,
  events: AsyncIterable<DataEvent>,
): AsyncGenerator<Data<S>> {
  let version: Version | undefined;
  let batches: DataBatch[] = [];
  for await (const event of events) {
    if (event.kind === 'begin') {
      if (version !== undefined) throw failure('invalid-input', 'Nested data transaction.');
      version = event.version;
    } else {
      if (version === undefined || event.version !== version)
        throw failure('conflict', 'Data transaction version differs.');
      if (event.kind === 'data') batches.push(event.block);
      else {
        const data = createData(schema, version, batches);
        version = undefined;
        batches = [];
        yield data;
      }
    }
  }
  if (version !== undefined) throw failure('invalid-input', 'Incomplete data transaction.');
}
