import {
  bitAt,
  failure,
  rowAt,
  rowCount,
  textAt,
  type Column,
  type Data,
  type FieldInput,
  type Reader,
} from '@latkit/model';
import type { ShapesInput } from './prepare/shapes.js';

/** Rows of a type, in the order shapes number them. */
export function rowsOf(source: Data, type: string): number {
  const table = source.tables[type];
  if (!table) throw failure('invalid-input', `No ${type} rows in the source`);
  return rowCount(table.rows);
}
/** A vector lane at a position of a vector column, as a list addresses it. */
function lane(column: Column, position: number, component: number): number {
  if (column.kind !== 'vector') return NaN;
  return column.values.values[
    column.values.offset + (column.offset + position) * column.size + component
  ];
}
/** Shapes as they gather, row by row: parts of points. */
class Gathered {
  readonly parts: number[] = [0];
  coordinates = new Float64Array(1024);
  points = 0;
  constructor(private readonly type: string) {}
  /** Append a row's shapes: a list of positions, or a list of lists, at a position of a list column. */
  row(column: Column, at: number): void {
    if (column.kind !== 'list')
      throw failure('invalid-input', `Shapes are lists of positions: ${this.type}`);
    if (!bitAt(column.validity, at)) return;
    const items = column.values,
      from = column.offsets[at],
      to = column.offsets[at + 1];
    if (items.kind === 'vector') this.part(items, from, to);
    else if (items.kind === 'list' && items.values.kind === 'vector')
      for (let p = from; p < to; p++) {
        const pat = items.offset + p;
        this.part(items.values, items.offsets[pat], items.offsets[pat + 1]);
      }
    else throw failure('invalid-input', `Shapes are lists of positions: ${this.type}`);
  }
  private part(points: Column, from: number, to: number): void {
    if (points.kind !== 'vector' || points.size < 2)
      throw failure('invalid-input', `Shapes need two coordinates: ${this.type}`);
    const needed = (this.points + to - from) * 2;
    if (needed > this.coordinates.length) {
      const grown = new Float64Array(Math.max(needed, this.coordinates.length * 2));
      grown.set(this.coordinates.subarray(0, this.points * 2));
      this.coordinates = grown;
    }
    const out = this.coordinates;
    for (let k = from; k < to; k++, this.points++) {
      out[this.points * 2] = lane(points, k, 0);
      out[this.points * 2 + 1] = lane(points, k, 1);
    }
    this.parts.push(this.points);
  }
}
/**
 * A type's shapes as the worker takes them: each row's parts of points, from a field of polylines
 * (a list of positions) or of rings or polylines (a list of lists). A field named outright reads
 * from the table's own pages, whole: a country of a hundred thousand points is one cell, larger
 * than any block a reader hands out.
 */
export async function readShapes(
  reader: Reader.Scope,
  source: Data,
  type: string,
  field: FieldInput,
  options: { readonly closed: boolean; readonly geodesic?: boolean },
): Promise<ShapesInput> {
  const rows = rowsOf(source, type),
    rowParts = new Uint32Array(rows + 1),
    gathered = new Gathered(type),
    table = source.tables[type];
  const pages = typeof field === 'string' ? table.fields[field] : undefined;
  if (typeof field === 'string' && !pages && !source.schema.types[type]?.fields[field])
    throw failure('invalid-input', `No ${field} field on ${type}`);
  if (pages) {
    // Each row's cell, by its place among the table's rows.
    const cells: ({ readonly column: Column; readonly at: number } | undefined)[] = new Array<
        { readonly column: Column; readonly at: number } | undefined
      >(rows),
      first = table.rows.kind === 'range' ? table.rows.offset : -1,
      places =
        table.rows.kind === 'indices'
          ? new Map(Array.from(table.rows.values, (row, i) => [row, i]))
          : undefined;
    for (const page of pages) {
      if (page.samples) continue;
      const count = rowCount(page.rows);
      for (let i = 0; i < count; i++) {
        const row = rowAt(page.rows, i),
          place = places ? places.get(row) : row - first;
        if (place !== undefined && place >= 0 && place < rows)
          cells[place] = { column: page.column, at: page.column.offset + i };
      }
    }
    for (let position = 0; position < rows; position++) {
      rowParts[position] = gathered.parts.length - 1;
      const cell = cells[position];
      if (cell) gathered.row(cell.column, cell.at);
    }
  } else {
    let position = 0;
    for await (const block of reader.fields({ source, from: type, fields: { shape: field } })) {
      const column = block.columns.shape,
        count = rowCount(block.rows);
      for (let i = 0; i < count; i++, position++) {
        rowParts[position] = gathered.parts.length - 1;
        if (column && bitAt(block.presence.shape, i)) gathered.row(column, column.offset + i);
      }
    }
  }
  rowParts[rows] = gathered.parts.length - 1;
  return {
    closed: options.closed,
    geodesic: options.geodesic,
    rowParts,
    parts: Uint32Array.from(gathered.parts),
    coordinates: gathered.coordinates.slice(0, gathered.points * 2),
  };
}
/** Each row's id, in the order shapes number them. */
export async function readIds(reader: Reader.Scope, source: Data, type: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const block of reader.fields({ source, from: type, fields: {}, ids: true })) {
    const column = block.ids,
      count = rowCount(block.rows);
    for (let i = 0; i < count; i++) ids.push(column ? (textAt(column, i) ?? '') : '');
  }
  return ids;
}
/**
 * Where each shape row's values lie among another type's rows of the same name, matched by id:
 * the value row, or `0xffffffff` where none matches.
 */
export async function matchRows(
  reader: Reader.Scope,
  shapes: Data,
  values: Data,
  type: string,
): Promise<Uint32Array> {
  const [own, theirs] = await Promise.all([
      readIds(reader, shapes, type),
      readIds(reader, values, type),
    ]),
    at = new Map<string, number>();
  theirs.forEach((id, row) => at.set(id, row));
  return Uint32Array.from(own, (id) => at.get(id) ?? 0xffffffff);
}
