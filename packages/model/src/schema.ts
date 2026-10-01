import type { DataType, NumericType } from './data.js';
import type { Query } from './query.js';
import type { Axis, Bounds, Value, Version } from './types.js';

/** The implementation describes domain data. Published descriptions are immutable. */
export interface Schema {
  readonly version: Version;
  /** Each advertised kind supports its complete defined semantics, not a partial implementation.
   * Document excludes samples/envelope and cannot read outputs through rows/aggregate. */
  readonly queries: readonly Query['kind'][];
  /** Per-data-block payload bound. Owned blocks also bound whole backing allocations.
   * Schema metadata and transport framing have separate transport limits. */
  readonly limits: { readonly maxBlockBytes: number };
  /** Type names are unique across all three maps. */
  readonly components: Readonly<Record<string, ComponentDefinition>>;
  readonly connections: Readonly<Record<string, ConnectionDefinition>>;
  readonly tables?: Readonly<Record<string, TableDefinition>>;
  /** Present only when observations are readable. Bound by Recording, never global to a Model. */
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
  readonly operations?: readonly ('add' | 'set' | 'remove')[];
}

export interface ComponentPort {
  readonly label?: string;
  readonly direction: 'in' | 'out' | 'both';
  readonly type?: string;
}

export interface ConnectionDefinition extends Description {
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly roles: Readonly<Record<string, ConnectionRole>>;
  readonly operations?: readonly ('add' | 'set' | 'remove' | 'reconnect')[];
}

export interface ConnectionRole {
  readonly min: number;
  readonly max?: number;
  readonly direction?: 'in' | 'out' | 'both';
}

export interface TableDefinition extends Description {
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly operations?: readonly ('insert' | 'set' | 'remove')[];
}

/**
 * Omitted creation inputs use defaults, then enforce requiredness. Remaining absent values read
 * as null and require nullable. Writable controls later set edits, not creation. Sampled fields
 * are observations, never inputs. Bounds apply only to scalar numeric inputs.
 */
export type FieldDefinition = {
  readonly label?: string;
  readonly description?: string;
  readonly nullable?: boolean;
} & (
  | {
      readonly sampled: true;
      readonly type: NumericType;
      readonly unit?: string;
      readonly writable?: never;
      readonly required?: never;
      readonly default?: never;
      readonly bounds?: never;
    }
  | {
      readonly sampled?: false;
      readonly type: DataType;
      readonly unit?: string;
      readonly bounds?: Bounds;
      readonly writable?: boolean;
      readonly required?: boolean;
      readonly default?: Value;
    }
);
