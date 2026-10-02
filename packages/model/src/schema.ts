import type { DataType, NumericType } from './data.js';
import type { Axis, Bounds } from './types.js';

/** The types and column shapes published by a model. */
export interface Schema {
  /** Topology is data: a reference field wires each row to a row of another type. */
  readonly types: Readonly<Record<string, TypeDefinition>>;
  /** Coordinate axis for sampled fields. Independent of commands. */
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

/** Both static and sampled fields may be monitored. Absent values
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
