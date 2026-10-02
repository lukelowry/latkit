import type { Data, DataEvent, DataPatch, TableData, ColumnPage } from './materialized.js';
import type { TextColumn } from './data.js';
import type { Schema } from './schema.js';
import type { Version } from './types.js';
import { assertIndex, rowAt, rowCount } from './access.js';
import { compactRows, containsRows, gather, position, sliceColumn } from './columns.js';
import { failure } from './error.js';

/** Construct a value from delivered pages. No storage exists outside the returned value. */
export function createData<S extends Schema>(
  schema: S,
  version: Version,
  patches: readonly DataPatch[],
): Data<S> {
  return appendData({ schema, version, tables: {} }, version, patches);
}

/** Explicit application storage: share unchanged pages and append supplied observations.
 * Use createData to discard previous observations. Neither function contacts a model.
 * A replacement row patch starts a new table; later patches can add its remaining pages. */
export function appendData<S extends Schema>(
  previous: Data<S>,
  version: Version,
  patches: readonly DataPatch[],
): Data<S> {
  const tables: Record<string, TableData> = { ...previous.tables };
  const writable = new WeakSet<ColumnPage[]>();
  for (const patch of patches) {
    const name = patch.index.type;
    if (!previous.schema.types[name]) throw failure('invalid-input', 'Unknown type: ' + name);
    const prior = patch.kind === 'rows' && patch.replace ? undefined : tables[name];
    if (prior) assertIndex(prior.index, patch.index);
    const fields: Record<string, readonly ColumnPage[]> = prior
      ? { ...prior.fields }
      : Object.fromEntries(
          Object.entries(previous.schema.types[name].fields)
            .filter(([, field]) => field.sampled)
            .map(([field]) => [field, []]),
        );
    for (const [field, column] of Object.entries(patch.columns)) {
      const definition = previous.schema.types[name].fields[field];
      if (!definition || Boolean(definition.sampled) !== (patch.kind === 'samples'))
        throw failure('invalid-input', 'Field shape differs from its schema: ' + field);
      const page: ColumnPage = {
        rows: patch.rows,
        column,
        ...(patch.kind === 'samples'
          ? { samples: { firstFrame: patch.firstFrame, coordinates: patch.coordinates } }
          : {}),
      };
      let pages = fields[field] as ColumnPage[] | undefined;
      if (!pages || !writable.has(pages)) {
        pages = [...(pages ?? [])];
        writable.add(pages);
      }
      if (patch.kind === 'rows' && pages.length) {
        const last = pages[pages.length - 1].rows;
        const beyond =
          last.kind === 'range' &&
          patch.rows.kind === 'range' &&
          patch.rows.offset >= last.offset + last.count;
        if (!beyond) pages = pages.flatMap((old) => subtract(old, patch.rows));
      }
      writable.add(pages);
      pages.push(page);
      fields[field] = pages;
    }
    let idPages = prior?.ids ?? [];
    if (patch.kind === 'rows' && patch.ids) {
      let pages = idPages as ColumnPage[];
      if (!writable.has(pages)) {
        pages = [...pages];
        writable.add(pages);
      }
      const last = pages.at(-1)?.rows;
      if (
        last &&
        !(
          last.kind === 'range' &&
          patch.rows.kind === 'range' &&
          patch.rows.offset >= last.offset + last.count
        )
      )
        pages = pages.flatMap((old) => subtract(old, patch.rows));
      pages.push({ rows: patch.rows, column: patch.ids });
      writable.add(pages);
      idPages = pages as readonly { rows: TableData['rows']; column: TextColumn }[];
    }
    tables[name] = {
      index: patch.index,
      rows: prior ? unionRows(prior.rows, patch.rows) : patch.rows,
      ids: idPages,
      fields,
    };
  }
  return { schema: previous.schema, version, tables };
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
  let patches: DataPatch[] = [];
  for await (const event of events) {
    if (event.kind === 'begin') {
      if (version !== undefined) throw failure('invalid-input', 'Nested data transaction.');
      version = event.version;
    } else {
      if (version === undefined || event.version !== version)
        throw failure('conflict', 'Data transaction version differs.');
      if (event.kind === 'data') patches.push(event.patch);
      else {
        const data = createData(schema, version, patches);
        version = undefined;
        patches = [];
        yield data;
      }
    }
  }
  if (version !== undefined) throw failure('invalid-input', 'Incomplete data transaction.');
}

/** Preserve the untouched part of an application-owned static page. */
function subtract(page: ColumnPage, replaced: TableData['rows']): ColumnPage[] {
  if (containsRows(replaced, page.rows)) return [];
  if (page.rows.kind === 'range' && replaced.kind === 'range') {
    const a = page.rows.offset,
      b = a + page.rows.count,
      c = replaced.offset,
      d = c + replaced.count;
    if (c >= b || d <= a) return [page];
    const pieces: ColumnPage[] = [];
    if (c > a)
      pieces.push({
        rows: { kind: 'range', offset: a, count: c - a },
        column: sliceColumn(page.column, 0, c - a),
      });
    if (d < b)
      pieces.push({
        rows: { kind: 'range', offset: d, count: b - d },
        column: sliceColumn(page.column, d - a, b - d),
      });
    return pieces;
  }
  const kept: number[] = [];
  for (let i = 0; i < rowCount(page.rows); i++)
    if (position(replaced, rowAt(page.rows, i)) < 0) kept.push(i);
  if (kept.length === rowCount(page.rows)) return [page];
  if (!kept.length) return [];
  return [
    {
      rows: compactRows(kept.map((i) => rowAt(page.rows, i))),
      column: gather(
        kept.map((at) => ({ column: page.column, at })),
        page.column,
      ),
    },
  ];
}
