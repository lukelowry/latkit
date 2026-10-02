import type {
  Column,
  DataType,
  NumericArray,
  NumericColumn,
  RowAxis,
  RowSelection,
  SampleColumn,
  TextColumn,
} from './data.js';
import type { ColumnPage, Data, TableData } from './materialized.js';
import type {
  AggregateBlock,
  AggregateQuery,
  EnvelopeBlock,
  EnvelopeColumn,
  EnvelopeQuery,
  Filter,
  Query,
  QueryBlock,
  QueryHeader,
  QueryOptions,
  RowsBlock,
  RowsQuery,
  SamplesBlock,
  SamplesQuery,
  SampleWindow,
} from './query.js';
import { assertIndex, bitAt, rowAt, rowCount, sliceRows, textAt } from './access.js';
import {
  compactRows,
  containsRows,
  copyBuffers,
  gather,
  position,
  sliceColumn,
  sliceSamples,
} from './columns.js';
import { blockBuffers, blockByteLength } from './buffers.js';
import { checkSignal, failure } from './error.js';
import { validateQuery } from './validation/query.js';

export type ReadResult<Q extends Query> =
  | QueryHeader
  | (Q extends RowsQuery
      ? RowsBlock
      : Q extends SamplesQuery
        ? SamplesBlock
        : Q extends EnvelopeQuery
          ? EnvelopeBlock
          : AggregateBlock);

/** Bounded local computation over application-owned values. Never performs I/O. */
export function read<Q extends Query>(
  data: Data,
  query: Q,
  options: QueryOptions = {},
): AsyncIterable<ReadResult<Q>> {
  return execute(data, query, options) as AsyncIterable<ReadResult<Q>>;
}

async function* execute(
  data: Data,
  query: Query,
  options: QueryOptions,
): AsyncGenerator<QueryHeader | QueryBlock> {
  checkSignal(options.signal);
  const issues = validateQuery(data.schema, query);
  if (issues.length) throw Object.assign(failure('invalid-input', issues[0].message), { issues });
  const bound = Math.min(data.schema.limits.maxBlockBytes, options.maxBlockBytes ?? Infinity);
  if (!Number.isSafeInteger(bound) || bound < 1)
    throw failure('invalid-input', 'Invalid block byte limit.');
  yield { kind: 'schema', schema: data.schema, version: data.version };
  const table = data.tables[query.from];
  if (!table) {
    if (query.kind === 'aggregate')
      for (const name of query.select)
        yield {
          kind: 'aggregate',
          version: data.version,
          values: {
            [name]: {
              count: 0,
              ...(query.measures.includes('min') ? { min: null } : {}),
              ...(query.measures.includes('max') ? { max: null } : {}),
            },
          },
        };
    return;
  }
  const blocks =
    query.kind === 'rows'
      ? rows(data, table, query, bound)
      : query.kind === 'samples'
        ? samples(data, table, query, bound)
        : query.kind === 'aggregate'
          ? aggregate(data, table, query, bound, options.signal)
          : envelope(data, table, query, bound, options.signal);
  for await (const block of blocks) {
    checkSignal(options.signal);
    const value = options.buffers === 'owned' ? copyBuffers(block) : block;
    if (
      blockByteLength(value) > bound ||
      (options.buffers === 'owned' &&
        blockBuffers(value).reduce((n, b) => n + b.byteLength, 0) > bound)
    )
      throw failure('resource-limit', 'A value exceeds the block byte limit.');
    yield value;
  }
}

const ids = new WeakMap<TableData, Map<string, number>>();
export function selectRows(
  table: TableData,
  selection?: RowSelection,
  available = table.rows,
): RowAxis {
  if (!selection) return available;
  let selected: RowAxis;
  if (selection.kind === 'ids') {
    let map = ids.get(table);
    if (!map) {
      map = new Map();
      for (const page of table.ids)
        for (let i = 0, n = rowCount(page.rows); i < n; i++) {
          const id = textAt(page.column, i);
          if (id !== null) map.set(id, rowAt(page.rows, i));
        }
      ids.set(table, map);
    }
    selected = compactRows(
      selection.ids.map((id) => {
        const row = map!.get(id);
        if (row === undefined) throw failure('invalid-input', 'Unknown row id: ' + id);
        return row;
      }),
    );
  } else {
    if (selection.index) assertIndex(table.index, selection.index);
    selected = selection;
  }
  if (!containsRows(available, selected))
    throw failure('invalid-input', 'Rows are outside available data.');
  return selected;
}

interface PageIndex {
  readonly sorted: readonly ColumnPage[];
  readonly ranges: boolean;
}
const pageIndexes = new WeakMap<readonly ColumnPage[], PageIndex>();
function pageIndex(pages: readonly ColumnPage[]): PageIndex {
  let index = pageIndexes.get(pages);
  if (!index) {
    const sorted = [...pages].sort(
      (a, b) =>
        (a.samples?.firstFrame ?? 0) - (b.samples?.firstFrame ?? 0) ||
        rowAtOrZero(a.rows) - rowAtOrZero(b.rows),
    );
    index = { sorted, ranges: sorted.every((p) => p.rows.kind === 'range') };
    pageIndexes.set(pages, index);
  }
  return index;
}
function rowAtOrZero(rows: RowAxis): number {
  return rows.kind === 'range' ? rows.offset : (rows.values[0] ?? 0);
}

function findPage(
  pages: readonly ColumnPage[],
  row: number,
  frame?: number,
): ColumnPage | undefined {
  const index = pageIndex(pages),
    list = index.sorted;
  if (frame === undefined && index.ranges) {
    let lo = 0,
      hi = list.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (rowAtOrZero(list[m].rows) <= row) lo = m + 1;
      else hi = m;
    }
    const page = list[lo - 1];
    return page && !page.samples && position(page.rows, row) >= 0 ? page : undefined;
  }
  // Frame groups have their own row index, keeping page lookup logarithmic for dense tiles.
  if (frame !== undefined) {
    const index = framesOf(pages),
      group = frameGroup(index, frame);
    if (!group) return undefined;
    if (group.ranges) {
      let lo = 0,
        hi = group.pages.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (rowAtOrZero(group.pages[m].rows) <= row) lo = m + 1;
        else hi = m;
      }
      const page = group.pages[lo - 1];
      return page && position(page.rows, row) >= 0 ? page : undefined;
    }
    return group.pages.find((p) => position(p.rows, row) >= 0);
  }
  return list.find((p) => !p.samples && position(p.rows, row) >= 0);
}

interface FrameGroup {
  readonly ordinal: number;
  readonly first: number;
  readonly coordinates: Float64Array;
  readonly pages: readonly ColumnPage[];
  readonly ranges: boolean;
}
interface Frames {
  readonly count: number;
  readonly groups: readonly FrameGroup[];
  readonly first: number;
  readonly end: number;
}
const frameIndexes = new WeakMap<readonly ColumnPage[], Frames>();
function framesOf(pages: readonly ColumnPage[]): Frames {
  let result = frameIndexes.get(pages);
  if (result) return result;
  const grouped = new Map<number, ColumnPage[]>();
  for (const page of pages)
    if (page.samples) {
      const parts = grouped.get(page.samples.firstFrame) ?? [];
      parts.push(page);
      grouped.set(page.samples.firstFrame, parts);
    }
  let count = 0;
  const groups = [...grouped]
    .sort((a, b) => a[0] - b[0])
    .map(([first, parts]) => ({
      ordinal:
        (count += parts[0].samples!.coordinates.length) - parts[0].samples!.coordinates.length,
      first,
      coordinates: parts[0].samples!.coordinates,
      pages: parts.sort((a, b) => rowAtOrZero(a.rows) - rowAtOrZero(b.rows)),
      ranges: parts.every((p) => p.rows.kind === 'range'),
    }));
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i],
      previous = groups[i - 1];
    if (
      previous &&
      (group.first < previous.first + previous.coordinates.length ||
        group.coordinates[0] < previous.coordinates.at(-1)!)
    )
      throw failure('conflict', 'Sample pages overlap or coordinates move backwards.');
    for (const page of group.pages) {
      const coordinates = page.samples!.coordinates;
      if (coordinates === group.coordinates) continue;
      if (coordinates.length !== group.coordinates.length)
        throw failure('conflict', 'Sample tile coordinate lengths differ.');
      for (let j = 0; j < coordinates.length; j++)
        if (coordinates[j] !== group.coordinates[j])
          throw failure('conflict', 'Sample tile coordinates differ.');
    }
  }
  result = {
    count,
    groups,
    first: groups[0]?.first ?? 0,
    end: groups.length ? groups.at(-1)!.first + groups.at(-1)!.coordinates.length : 0,
  };
  frameIndexes.set(pages, result);
  return result;
}
function frameGroup(index: Frames, frame: number): FrameGroup | undefined {
  let lo = 0,
    hi = index.groups.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (index.groups[m].first <= frame) lo = m + 1;
    else hi = m;
  }
  const group = index.groups[lo - 1];
  return group && frame < group.first + group.coordinates.length ? group : undefined;
}
function coordinateBound(index: Frames, value: number, upper: boolean): number {
  let lo = 0,
    hi = index.groups.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1,
      last = index.groups[m].coordinates.at(-1)!;
    if (last < value || (upper && last === value)) lo = m + 1;
    else hi = m;
  }
  const group = index.groups[lo];
  if (!group) return index.count;
  let a = 0,
    b = group.coordinates.length;
  while (a < b) {
    const m = (a + b) >>> 1,
      coordinate = group.coordinates[m];
    if (coordinate < value || (upper && coordinate === value)) a = m + 1;
    else b = m;
  }
  return group.ordinal + a;
}
function frameRange(index: Frames, window: SampleWindow): [number, number] {
  if (!index.groups.length) {
    if (window.kind === 'frames' && window.count)
      throw failure('invalid-input', 'Requested observations are unavailable.');
    return [index.first, index.first];
  }
  if (window.kind === 'frames') {
    if (window.offset < index.first || window.offset + window.count > index.end)
      throw failure('invalid-input', 'Requested observations are unavailable.');
    let covered = window.offset;
    for (const group of index.groups) {
      if (group.first + group.coordinates.length <= covered) continue;
      if (group.first > covered) break;
      covered = group.first + group.coordinates.length;
      if (covered >= window.offset + window.count) break;
    }
    if (covered < window.offset + window.count)
      throw failure('invalid-input', 'Requested observations contain a gap.');
    return [window.offset, window.offset + window.count];
  }
  if (window.kind === 'at') {
    const end = coordinateBound(index, window.value, true);
    if (!end) return [index.first, index.first];
    const frame = ordinalFrame(index, end - 1);
    return [frame, frame + 1];
  }
  const first = Math.max(
    0,
    coordinateBound(index, window.between[0], false) - (window.context?.before ?? 0),
  );
  const end = Math.min(
    index.count,
    coordinateBound(index, window.between[1], true) + (window.context?.after ?? 0),
  );
  const startFrame = ordinalFrame(index, first);
  return [startFrame, end > first ? ordinalFrame(index, end - 1) + 1 : startFrame];
}
function ordinalFrame(index: Frames, ordinal: number): number {
  if (ordinal >= index.count) return index.end;
  let lo = 0,
    hi = index.groups.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (index.groups[m].ordinal <= ordinal) lo = m + 1;
    else hi = m;
  }
  const group = index.groups[lo - 1];
  return group.first + ordinal - group.ordinal;
}

function pagesFor(table: TableData, field: string): readonly ColumnPage[] {
  const pages = table.fields[field];
  if (!pages) throw failure('invalid-input', 'Field has not been supplied: ' + field);
  return pages;
}
function availableRows(pages: readonly ColumnPage[], frame: number): RowAxis {
  const group = frameGroup(framesOf(pages), frame);
  if (!group) return { kind: 'range', offset: 0, count: 0 };
  if (group.pages.length === 1) return group.pages[0].rows;
  const first = rowAtOrZero(group.pages[0].rows);
  let end = first;
  if (
    group.ranges &&
    group.pages.every((p) => {
      const r = p.rows as Extract<RowAxis, { kind: 'range' }>;
      if (r.offset !== end) return false;
      end += r.count;
      return true;
    })
  )
    return { kind: 'range', offset: first, count: end - first };
  return compactRows(
    group.pages
      .flatMap((p) => Array.from({ length: rowCount(p.rows) }, (_, i) => rowAt(p.rows, i)))
      .sort((a, b) => a - b),
  );
}

function intersect(a: RowAxis, b: RowAxis): RowAxis {
  if (containsRows(b, a)) return a;
  if (containsRows(a, b)) return b;
  if (a.kind === 'range' && b.kind === 'range') {
    const offset = Math.max(a.offset, b.offset);
    return {
      kind: 'range',
      offset,
      count: Math.max(0, Math.min(a.offset + a.count, b.offset + b.count) - offset),
    };
  }
  const values: number[] = [];
  for (let i = 0; i < rowCount(a); i++) {
    const row = rowAt(a, i);
    if (position(b, row) >= 0) values.push(row);
  }
  return compactRows(values);
}
function sampleRows(
  table: TableData,
  fields: readonly string[],
  selection: RowSelection | undefined,
  first: number,
  end: number,
): RowAxis {
  let available = table.rows;
  for (const field of fields)
    for (const group of framesOf(pagesFor(table, field)).groups) {
      if (group.first >= end) break;
      if (group.first + group.coordinates.length <= first) continue;
      available = intersect(available, availableRows(pagesFor(table, field), group.first));
    }
  return selectRows(table, selection, available);
}

function columnFor(
  pages: readonly ColumnPage[],
  selected: RowAxis,
  type: DataType,
  frame?: number,
): Column {
  const count = rowCount(selected);
  if (!count) return pages.length ? sliceColumn(pages[0].column, 0, 0) : emptyColumn(type);
  const first = findPage(pages, rowAt(selected, 0), frame);
  if (
    first &&
    selected.kind === 'range' &&
    first.rows.kind === 'range' &&
    containsRows(first.rows, selected)
  ) {
    const row = selected.offset - first.rows.offset;
    if (frame === undefined) return sliceColumn(first.column, row, count);
    const column = first.column as SampleColumn;
    if (column.rowStride === 1)
      return sliceColumn(
        column,
        (frame - first.samples!.firstFrame) * column.frameStride + row,
        count,
      );
  }
  const cells = Array.from({ length: count }, (_, i) => {
    const row = rowAt(selected, i),
      page = findPage(pages, row, frame);
    if (!page)
      throw failure('invalid-input', 'Field does not cover the requested rows and observations.');
    const c = page.column as SampleColumn,
      at = position(page.rows, row);
    return {
      column: page.column,
      at:
        frame === undefined
          ? at
          : at * c.rowStride + (frame - page.samples!.firstFrame) * c.frameStride,
    };
  });
  return gather(cells, pages[0]?.column ?? emptyColumn(type));
}

export function emptyColumn(type: DataType): Column {
  const base = { offset: 0, length: 0 };
  if (typeof type === 'string') {
    if (type === 'text')
      return { kind: 'text', ...base, bytes: new Uint8Array(), offsets: new Int32Array(1) };
    if (type === 'boolean') return { kind: 'boolean', ...base, values: new Uint8Array() };
    const values =
      type === 'float64'
        ? new Float64Array()
        : type === 'float32'
          ? new Float32Array()
          : type === 'int32'
            ? new Int32Array()
            : new Uint32Array();
    return { kind: 'numeric', ...base, values };
  }
  if (type.kind === 'vector')
    return {
      kind: 'vector',
      ...base,
      size: type.size,
      values: emptyColumn(type.items) as NumericColumn,
    };
  if (type.kind === 'list')
    return { kind: 'list', ...base, offsets: new Int32Array(1), values: emptyColumn(type.items) };
  return {
    kind: 'reference',
    ...base,
    values: new Uint32Array(),
    index: { source: 'empty', type: type.to, version: 'empty' },
  };
}

function scalar(column: Column, row: number, data?: Data): string | number | boolean | null {
  const at = column.offset + row;
  if (!bitAt(column.validity, at)) return null;
  if (column.kind === 'numeric') return column.values[at];
  if (column.kind === 'reference') {
    const target = data?.tables[column.index.type];
    if (!target) throw failure('invalid-input', 'Reference target IDs have not been supplied.');
    assertIndex(target.index, column.index);
    const id = columnFor(
      target.ids,
      { kind: 'range', offset: column.values[at], count: 1 },
      'text',
    ) as TextColumn;
    return textAt(id, 0);
  }
  if (column.kind === 'boolean') return bitAt(column.values, at);
  if (column.kind === 'text') return textAt(column, row);
  throw failure('unsupported', 'This operation requires scalar values.');
}
function matches(value: string | number | boolean | null, filter: Filter): boolean {
  switch (filter.operator) {
    case 'equal':
      return value === filter.value;
    case 'notEqual':
      return value !== filter.value;
    case 'contains':
      return (
        typeof value === 'string' &&
        typeof filter.value === 'string' &&
        value.includes(filter.value)
      );
    case 'lessThan':
      return typeof value === 'number' && value < filter.value;
    case 'lessThanOrEqual':
      return typeof value === 'number' && value <= filter.value;
    case 'greaterThan':
      return typeof value === 'number' && value > filter.value;
    case 'greaterThanOrEqual':
      return typeof value === 'number' && value >= filter.value;
  }
}

function* rows(
  data: Data,
  table: TableData,
  query: RowsQuery,
  bound: number,
): Generator<RowsBlock> {
  const definitions = data.schema.types[query.from].fields;
  const used = [
    ...new Set([
      ...query.select,
      ...(query.where ?? []).map((f) => f.field),
      ...(query.orderBy ?? []).map((f) => f.field),
    ]),
  ];
  const sampled = used.filter((name) => definitions[name].sampled);
  const frames = new Map<string, number>();
  let available = table.rows;
  for (const name of sampled) {
    const pages = pagesFor(table, name),
      index = framesOf(pages),
      range = frameRange(index, { kind: 'at', value: query.at! });
    if (range[0] === range[1]) return;
    frames.set(name, range[0]);
    available = intersect(available, availableRows(pages, range[0]));
  }
  let selected = selectRows(table, query.rows, available);
  if (query.where?.length || query.orderBy?.length) {
    const fields = new Map(
      used.map((name) => [
        name,
        columnFor(pagesFor(table, name), selected, definitions[name].type, frames.get(name)),
      ]),
    );
    let positions = Array.from({ length: rowCount(selected) }, (_, i) => i);
    if (query.where?.length)
      positions = positions.filter((i) =>
        query.where!.every((f) => matches(scalar(fields.get(f.field)!, i, data), f)),
      );
    if (query.orderBy?.length)
      positions.sort((a, b) => {
        for (const order of query.orderBy!) {
          const left = scalar(fields.get(order.field)!, a),
            right = scalar(fields.get(order.field)!, b);
          const lm = left === null || (typeof left === 'number' && !Number.isFinite(left)),
            rm = right === null || (typeof right === 'number' && !Number.isFinite(right));
          if (lm !== rm) return lm ? 1 : -1;
          if (lm) continue;
          const comparison = left! < right! ? -1 : left! > right! ? 1 : 0;
          if (comparison) return order.direction === 'ascending' ? comparison : -comparison;
        }
        return rowAt(selected, a) - rowAt(selected, b);
      });
    selected = compactRows(positions.map((i) => rowAt(selected, i)));
  }
  const total = rowCount(selected),
    start = Math.min(total, query.offset ?? 0);
  selected = sliceRows(selected, start, Math.min(total - start, query.limit ?? total));
  const count = rowCount(selected);
  const width = Math.max(
    8,
    query.select.reduce((n, field) => n + widthOf(definitions[field].type), query.ids ? 32 : 0),
  );
  for (let offset = 0; offset < count || (offset === 0 && !count && query.count);) {
    let n = Math.min(count - offset, Math.max(1, Math.floor((bound - 512) / width)));
    if (selected.kind === 'range' && n)
      for (const name of query.select) {
        const page = findPage(pagesFor(table, name), selected.offset + offset, frames.get(name));
        if (page?.rows.kind === 'range')
          n = Math.min(n, page.rows.offset + page.rows.count - selected.offset - offset);
      }
    let block: RowsBlock;
    for (;;) {
      const part = sliceRows(selected, offset, n);
      const columns = Object.fromEntries(
        query.select.map((name) => [
          name,
          columnFor(pagesFor(table, name), part, definitions[name].type, frames.get(name)),
        ]),
      );
      block = {
        kind: 'rows',
        version: data.version,
        index: table.index,
        rows: part,
        position: offset,
        columns,
        ...(query.count ? { total } : {}),
        ...(query.ids ? { ids: columnFor(table.ids, part, 'text') as TextColumn } : {}),
      };
      if (blockByteLength(block) <= bound || n <= 1) break;
      n = Math.ceil(n / 2);
    }
    yield block;
    if (!n) break;
    offset += n;
  }
}
function widthOf(type: DataType): number {
  if (typeof type === 'string') return type === 'float64' ? 9 : type === 'text' ? 32 : 5;
  return type.kind === 'vector'
    ? type.size * widthOf(type.items) + 1
    : type.kind === 'reference'
      ? 5
      : 64;
}

function sampleColumn(
  pages: readonly ColumnPage[],
  selected: RowAxis,
  first: number,
  nf: number,
  type: DataType,
): SampleColumn {
  const nr = rowCount(selected),
    page = nr ? findPage(pages, rowAt(selected, 0), first) : undefined;
  if (
    page?.samples &&
    selected.kind === 'range' &&
    page.rows.kind === 'range' &&
    containsRows(page.rows, selected) &&
    first + nf <= page.samples.firstFrame + page.samples.coordinates.length
  )
    return sliceSamples(
      page.column as SampleColumn,
      selected.offset - page.rows.offset,
      nr,
      first - page.samples.firstFrame,
      nf,
    );
  const template = emptyColumn(type) as NumericColumn;
  const Constructor = template.values.constructor as { new (length: number): NumericArray };
  const values = new Constructor(nr * nf),
    validity = new Uint8Array(Math.ceil(values.length / 8));
  let nullable = false;
  for (let f = 0; f < nf; f++) {
    const contiguous =
      nr && selected.kind === 'range' ? findPage(pages, selected.offset, first + f) : undefined;
    if (
      contiguous?.samples &&
      selected.kind === 'range' &&
      contiguous.rows.kind === 'range' &&
      containsRows(contiguous.rows, selected)
    ) {
      const c = contiguous.column as SampleColumn,
        at =
          c.offset +
          (selected.offset - contiguous.rows.offset) * c.rowStride +
          (first + f - contiguous.samples.firstFrame) * c.frameStride;
      if (c.rowStride === 1) {
        values.set(c.values.subarray(at, at + nr), f * nr);
        for (let r = 0; r < nr; r++) {
          const to = f * nr + r;
          if (bitAt(c.validity, at + r)) validity[to >>> 3] |= 1 << (to & 7);
          else nullable = true;
        }
        continue;
      }
    }
    for (let r = 0; r < nr; r++) {
      const row = rowAt(selected, r),
        p = findPage(pages, row, first + f);
      if (!p?.samples)
        throw failure('invalid-input', 'Samples do not cover the requested rectangle.');
      const c = p.column as SampleColumn,
        at =
          c.offset +
          position(p.rows, row) * c.rowStride +
          (first + f - p.samples.firstFrame) * c.frameStride,
        to = f * nr + r;
      values[to] = c.values[at];
      if (bitAt(c.validity, at)) validity[to >>> 3] |= 1 << (to & 7);
      else nullable = true;
    }
  }
  return {
    kind: 'numeric',
    offset: 0,
    length: values.length,
    values,
    rowStride: 1,
    frameStride: nr,
    ...(nullable ? { validity } : {}),
  };
}

/** Largest contiguous prefix, without inventing frames across missing observations. */
function frameSpan(index: Frames, first: number, count: number): number {
  let frame = first;
  while (frame < first + count) {
    const group = frameGroup(index, frame);
    if (!group) break;
    frame = Math.min(first + count, group.first + group.coordinates.length);
  }
  return frame - first;
}
function coordinatesFor(index: Frames, first: number, count: number): Float64Array {
  const group = frameGroup(index, first)!;
  if (first + count <= group.first + group.coordinates.length)
    return group.coordinates.subarray(first - group.first, first - group.first + count);
  const result = new Float64Array(count);
  for (let offset = 0; offset < count;) {
    const part = frameGroup(index, first + offset)!,
      at = first + offset - part.first,
      n = Math.min(count - offset, part.coordinates.length - at);
    result.set(part.coordinates.subarray(at, at + n), offset);
    offset += n;
  }
  return result;
}
function* samples(
  data: Data,
  table: TableData,
  query: SamplesQuery,
  bound: number,
): Generator<SamplesBlock> {
  const definitions = data.schema.types[query.from].fields;
  const indexes = query.select.map((name) => framesOf(pagesFor(table, name))),
    index = indexes[0];
  const [first, end] = frameRange(index, query.window);
  if (first === end) return;
  const selected = sampleRows(table, query.select, query.rows, first, end),
    nr = rowCount(selected);
  const width = query.select.reduce((n, f) => n + widthOf(definitions[f].type), 0);
  let next = first;
  for (const group of index.groups) {
    const stop = Math.min(end, group.first + group.coordinates.length);
    for (let frame = Math.max(next, group.first); frame < stop;) {
      // Coalesce small publications into bounded local batches. Keep large delivered tiles as views.
      let nf = Math.min(
        64,
        end - frame,
        Math.max(1, Math.floor((bound - 1024) / Math.max(width, 8 + Math.min(nr, 1024) * width))),
      );
      const following = frameGroup(index, stop);
      const currentValues = group.pages[0]?.column;
      const nextValues = following?.pages[0]?.column;
      if (
        currentValues?.kind === 'numeric' &&
        nextValues?.kind === 'numeric' &&
        currentValues.values.buffer === nextValues.values.buffer
      )
        nf = Math.min(nf, stop - frame);
      for (const other of indexes) nf = Math.min(nf, frameSpan(other, frame, nf));
      if (!nf) throw failure('invalid-input', 'Sample field coverage differs.');
      let strideBytes = 8;
      for (let i = 0; i < query.select.length; i++) {
        const current = frameGroup(indexes[i], frame)!;
        if (frame + nf <= current.first + current.coordinates.length)
          strideBytes += current.pages.reduce((max, page) => {
            const c = page.column as SampleColumn;
            return Math.max(max, c.frameStride * (c.values.BYTES_PER_ELEMENT + 1 / 8));
          }, 1);
      }
      nf = Math.min(nf, Math.max(1, Math.floor((bound - 1024) / strideBytes)));
      const coordinates = coordinatesFor(index, frame, nf);
      for (const other of indexes.slice(1)) {
        const values = coordinatesFor(other, frame, nf);
        for (let f = 0; f < nf; f++)
          if (values[f] !== coordinates[f])
            throw failure('conflict', 'Sample coordinates differ across fields.');
      }
      for (let offset = 0; offset < nr;) {
        let n = Math.min(
          nr - offset,
          Math.max(1, Math.floor((bound - 512 - nf * 8) / (nf * width))),
        );
        if (selected.kind === 'range')
          for (const name of query.select) {
            const page = findPage(pagesFor(table, name), selected.offset + offset, frame);
            if (page?.rows.kind === 'range')
              n = Math.min(n, page.rows.offset + page.rows.count - selected.offset - offset);
          }
        let block: SamplesBlock;
        for (;;) {
          const part = sliceRows(selected, offset, n);
          block = {
            kind: 'samples',
            version: data.version,
            index: table.index,
            rows: part,
            rowOffset: offset,
            firstFrame: frame,
            coordinates,
            columns: Object.fromEntries(
              query.select.map((name) => [
                name,
                sampleColumn(pagesFor(table, name), part, frame, nf, definitions[name].type),
              ]),
            ),
          };
          if (blockByteLength(block) <= bound || (n === 1 && nf === 1)) break;
          if (n > 1) n = Math.ceil(n / 2);
          else throw failure('resource-limit', 'Sample tile exceeds its byte bound.');
        }
        yield block;
        offset += n;
      }
      frame += nf;
      next = frame;
    }
  }
}

async function* aggregate(
  data: Data,
  table: TableData,
  query: AggregateQuery,
  bound: number,
  signal?: AbortSignal,
): AsyncGenerator<AggregateBlock> {
  let yieldedAt = performance.now();
  const values: Record<string, { count: number; min: number | null; max: number | null }> =
    Object.fromEntries(query.select.map((name) => [name, { count: 0, min: null, max: null }]));
  const input = query.window
    ? samples(data, table, { ...query, kind: 'samples', window: query.window }, bound)
    : rows(
        data,
        table,
        { kind: 'rows', from: query.from, rows: query.rows, select: query.select },
        bound,
      );
  for (const block of input) {
    if (performance.now() - yieldedAt > 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      yieldedAt = performance.now();
    }
    checkSignal(signal);
    for (const name of query.select) {
      const column = block.columns[name] as SampleColumn,
        target = values[name];
      const nr = rowCount(block.rows),
        nf = block.kind === 'samples' ? block.coordinates.length : 1;
      for (let f = 0; f < nf; f++)
        for (let r = 0; r < nr; r++) {
          const at =
              column.offset +
              (block.kind === 'samples' ? f * column.frameStride + r * column.rowStride : r),
            value = column.values[at];
          if (!bitAt(column.validity, at) || !Number.isFinite(value)) continue;
          target.count++;
          target.min = target.min === null ? value : Math.min(target.min, value);
          target.max = target.max === null ? value : Math.max(target.max, value);
        }
    }
  }
  for (const name of query.select) {
    const value = values[name];
    yield {
      kind: 'aggregate',
      version: data.version,
      values: {
        [name]: {
          count: value.count,
          ...(query.measures.includes('min') ? { min: value.min } : {}),
          ...(query.measures.includes('max') ? { max: value.max } : {}),
        },
      },
    };
  }
}

async function* envelope(
  data: Data,
  table: TableData,
  query: EnvelopeQuery,
  bound: number,
  signal?: AbortSignal,
): AsyncGenerator<EnvelopeBlock> {
  let yieldedAt = performance.now();
  const anchor = pagesFor(table, query.select[0]),
    index = framesOf(anchor),
    [first, end] = frameRange(index, query.window);
  if (first === end) return;
  const selected = sampleRows(table, query.select, query.rows, first, end);
  const nr = rowCount(selected),
    rowBytes =
      query.buckets *
      query.select.reduce(
        (n, field) =>
          n + (data.schema.types[query.from].fields[field].type === 'float64' ? 97 : 81),
        0,
      );
  const capacity = Math.floor((bound - 1024) / rowBytes);
  if (capacity < 1) throw failure('resource-limit', 'Envelope exceeds the block byte limit.');
  for (let offset = 0; offset < nr; offset += capacity) {
    const part = sliceRows(selected, offset, Math.min(capacity, nr - offset)),
      count = rowCount(part),
      columns: Record<string, EnvelopeColumn> = {};
    const invalid = new Map<string, Uint8Array>();
    for (const name of query.select) {
      const template = emptyColumn(
        data.schema.types[query.from].fields[name].type,
      ) as NumericColumn;
      const Constructor = template.values.constructor as { new (length: number): NumericArray };
      const length = count * query.buckets * 4;
      columns[name] = {
        values: {
          kind: 'numeric',
          offset: 0,
          length,
          values: new Constructor(length),
          validity: new Uint8Array(Math.ceil(length / 8)),
        },
        coordinates: new Float64Array(length),
        frames: new Float64Array(length),
        continuous: new Uint8Array(Math.ceil((count * query.buckets) / 8)),
      };
      invalid.set(name, new Uint8Array(count * query.buckets));
    }
    const lastFrames = new Float64Array(count).fill(-Infinity);
    const [lo, hi] = query.window.between,
      span = hi - lo;
    for (const block of samples(
      data,
      table,
      {
        kind: 'samples',
        from: query.from,
        rows: { ...part, index: table.index },
        select: query.select,
        window: query.window,
      },
      bound,
    )) {
      if (performance.now() - yieldedAt > 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        yieldedAt = performance.now();
      }
      checkSignal(signal);
      for (let f = 0; f < block.coordinates.length; f++) {
        const coordinate = block.coordinates[f],
          bucket = span
            ? Math.max(
                0,
                Math.min(query.buckets - 1, Math.floor(((coordinate - lo) / span) * query.buckets)),
              )
            : 0;
        for (let r = 0; r < rowCount(block.rows); r++) {
          const row = position(part, rowAt(block.rows, r)),
            cell = row * query.buckets + bucket,
            base = cell * 4;
          const absolute = block.firstFrame + f;
          const gap = Number.isFinite(lastFrames[row]) && absolute !== lastFrames[row] + 1;
          lastFrames[row] = absolute;
          for (const name of query.select) {
            if (gap) invalid.get(name)![cell] = 1;
            const c = block.columns[name],
              at = c.offset + f * c.frameStride + r * c.rowStride,
              value = c.values[at],
              target = columns[name];
            if (!bitAt(c.validity, at) || !Number.isFinite(value)) {
              invalid.get(name)![cell] = 1;
              continue;
            }
            const seen = bitAt(target.values.validity, base),
              frame = block.firstFrame + f;
            const write = (slot: number) => {
              const i = base + slot;
              target.values.values[i] = value;
              target.coordinates[i] = coordinate;
              target.frames[i] = frame;
              target.values.validity![i >>> 3] |= 1 << (i & 7);
            };
            if (!seen) for (let slot = 0; slot < 4; slot++) write(slot);
            else {
              if (value < target.values.values[base + 1]) write(1);
              if (value > target.values.values[base + 2]) write(2);
              write(3);
            }
          }
        }
      }
    }
    for (const name of query.select) {
      const c = columns[name];
      for (let i = 0; i < count * query.buckets; i++)
        if (bitAt(c.values.validity, i * 4) && !invalid.get(name)![i])
          c.continuous[i >>> 3] |= 1 << (i & 7);
    }
    yield {
      kind: 'envelope',
      version: data.version,
      index: table.index,
      rows: part,
      rowOffset: offset,
      firstBucket: 0,
      bucketCount: query.buckets,
      columns,
    };
  }
}
