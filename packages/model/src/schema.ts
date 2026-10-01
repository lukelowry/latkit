import type { DataType, NumericType } from './data.js';
import type { Query } from './query.js';
import type { Axis, Bounds } from './types.js';

/** The types a Model or Recording holds, fixed for its life. */
export interface Schema {
  /** Each advertised kind supports its complete defined semantics, not a partial implementation.
   * A Model excludes samples/envelope and cannot read sampled fields through rows/aggregate. */
  readonly queries: readonly Query['kind'][];
  /** Per-data-block payload bound. Owned blocks also bound whole backing allocations.
   * Schema metadata and transport framing have separate transport limits. */
  readonly limits: { readonly maxBlockBytes: number };
  /** Topology is data: a reference field wires each row to a row of another type. */
  readonly types: Readonly<Record<string, TypeDefinition>>;
  /** Present only when observations are readable: on a Recording, never on a Model. */
  readonly axis?: Axis;
}

export interface TypeDefinition {
  readonly label?: string;
  readonly description?: string;
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  /** The field holding each row's position, a 2D/3D vector or a list of them. Styling, layout,
   * and inspector configuration belong to the host. */
  readonly spatial?: { readonly field: string; readonly system: 'geographic' | 'cartesian' };
}

/** Sampled fields are what a monitor can stream; the rest are the model's data. Absent values
 * read as null and require nullable. Bounds describe scalar numeric data. */
export type FieldDefinition = {
  readonly label?: string;
  readonly description?: string;
  readonly nullable?: boolean;
  readonly unit?: string;
  /** References only: the way it carries flow, such as a block's input or output. Omitted is
   * undirected. */
  readonly direction?: 'in' | 'out';
} & (
  | { readonly sampled: true; readonly type: NumericType; readonly bounds?: never }
  | { readonly sampled?: false; readonly type: DataType; readonly bounds?: Bounds }
);
