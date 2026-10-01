import type { DataType, NumericType } from './data.js';
import type { Query } from './query.js';
import type { Axis, Bounds } from './types.js';

/** The classes a Model or Recording holds, fixed for its life. */
export interface Schema {
  /** Each advertised kind supports its complete defined semantics, not a partial implementation.
   * A Model excludes samples/envelope and cannot read sampled fields through rows/aggregate. */
  readonly queries: readonly Query['kind'][];
  /** Per-data-block payload bound. Owned blocks also bound whole backing allocations.
   * Schema metadata and transport framing have separate transport limits. */
  readonly limits: { readonly maxBlockBytes: number };
  /** Type names are unique across all three maps. */
  readonly components: Readonly<Record<string, ComponentDefinition>>;
  readonly connections: Readonly<Record<string, ConnectionDefinition>>;
  readonly tables?: Readonly<Record<string, TableDefinition>>;
  /** Present only when observations are readable: on a Recording, never on a Model. */
  readonly axis?: Axis;
}

interface Description {
  readonly label?: string;
  readonly description?: string;
  /** Domain coordinates only. Styling, layout, and inspector configuration belong to the host. */
  readonly spatial?: { readonly field: string; readonly system: string };
}

export interface ComponentDefinition extends Description {
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly ports?: Readonly<Record<string, ComponentPort>>;
}

export interface ComponentPort {
  readonly label?: string;
  readonly direction: 'in' | 'out' | 'both';
  readonly type?: string;
}

export interface ConnectionDefinition extends Description {
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly roles: Readonly<Record<string, ConnectionRole>>;
}

export interface ConnectionRole {
  readonly min: number;
  readonly max?: number;
  readonly direction?: 'in' | 'out' | 'both';
}

export interface TableDefinition extends Description {
  readonly fields: Readonly<Record<string, FieldDefinition>>;
}

/** Sampled fields are what a monitor can stream; the rest are the model's data. Absent values
 * read as null and require nullable. Bounds describe scalar numeric data. */
export type FieldDefinition = {
  readonly label?: string;
  readonly description?: string;
  readonly nullable?: boolean;
  readonly unit?: string;
} & (
  | { readonly sampled: true; readonly type: NumericType; readonly bounds?: never }
  | { readonly sampled?: false; readonly type: DataType; readonly bounds?: Bounds }
);
