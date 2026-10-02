import type { Data, DataBatch } from './materialized.js';
import type { FieldSelection, QueryOptions } from './query.js';
import { sampleDomain } from './pages.js';
import { read } from './read.js';
import { validateSelection } from './validation/selection.js';
import { failure } from './error.js';

/** Select supplied values locally. Captures one immutable Data value; never subscribes or fetches. */
export async function* selectBatches(
  data: Data,
  selections: readonly FieldSelection[],
  options: QueryOptions = {},
): AsyncGenerator<DataBatch> {
  for (const selection of selections) {
    options.signal?.throwIfAborted();
    const issues = validateSelection(data.schema, selection);
    if (issues.length) throw failure('invalid-input', issues[0].message);
    const table = data.tables[selection.from];
    if (!table) continue;
    const definitions = data.schema.types[selection.from].fields;
    const fields = selection.select.filter((name) => !definitions[name].sampled);
    if (fields.length || table.ids.length) {
      for await (const block of read(
        data,
        { ...selection, kind: 'rows', select: fields, ids: table.ids.length > 0 },
        options,
      ))
        yield {
          kind: 'rows',
          index: block.index,
          rows: block.rows,
          columns: block.columns,
          ...(block.ids && { ids: block.ids }),
        };
    }
    // One indexed read per sampled field: independent clocks and coverage stay independent.
    for (const field of selection.select) {
      if (!definitions[field].sampled) continue;
      const between = sampleDomain(table.fields[field]);
      if (!between) continue;
      for await (const block of read(
        data,
        { ...selection, kind: 'samples', select: [field], window: { kind: 'range', between } },
        options,
      ))
        yield {
          kind: 'samples',
          index: block.index,
          rows: block.rows,
          firstFrame: block.firstFrame,
          coordinates: block.coordinates,
          columns: block.columns,
        };
    }
  }
}
