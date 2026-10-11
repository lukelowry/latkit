/** The types and column shapes published by a model. */
export interface Schema {
  /** Topology is data: a reference field wires each row to a row of another type. */
  readonly types: Readonly<Record<string, Schema.Type>>;
  /** Coordinate axis for sampled fields. Independent of commands. */
  readonly axis?: Schema.Axis;
}
export declare namespace Schema {
  /** A type's fields. Styling, layout, and inspector configuration belong to the host. */
  interface Type {
    readonly label?: string;
    readonly description?: string;
    readonly fields: Readonly<Record<string, Field>>;
  }
  /**
   * Both static and sampled fields may be monitored. Absent values read as null and require
   * nullable. Bounds describe scalar numeric data.
   */
  type Field = {
    readonly label?: string;
    readonly description?: string;
    readonly nullable?: boolean;
    readonly unit?: string;
    /** References only: the way it carries flow, such as a block's input or output. Omitted is undirected. */
    readonly direction?: 'in' | 'out';
    /**
     * Longitude and latitude in degrees, rather than plane coordinates: a 2D/3D vector, a list of
     * them, or one numeric axis of a position.
     */
    readonly geographic?: boolean;
  } & (
    | { readonly sampled: true; readonly type: NumericType; readonly bounds?: never }
    | { readonly sampled?: false; readonly type: FieldType; readonly bounds?: Bounds }
  );
  type NumericType = 'float32' | 'float64' | 'int32' | 'uint32';
  /** A deliberately small columnar vocabulary; no arbitrary object cells. */
  type FieldType =
    | NumericType
    | 'text'
    | 'boolean'
    /** A row of type `to`: how one row is wired to another. */
    | { readonly kind: 'reference'; readonly to: string }
    | { readonly kind: 'vector'; readonly items: NumericType; readonly size: number }
    | { readonly kind: 'list'; readonly items: FieldType };
  /** Meaning of observation coordinates; never an implicitly chosen wall clock. */
  interface Axis {
    readonly name: string;
    readonly unit?: string;
  }
  interface Bound {
    readonly value: number;
    /** Defaults to true. */
    readonly inclusive?: boolean;
  }
  interface Bounds {
    readonly lower?: Bound;
    readonly upper?: Bound;
  }
}
