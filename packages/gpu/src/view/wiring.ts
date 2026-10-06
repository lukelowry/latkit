import {
  assertIndex,
  failure,
  rowCount,
  type Data,
  type Index,
  type ReadScope,
  type RowSelection,
  type Schema,
} from '@latkit/model';

/**
 * The rows a selection names, ids included, in the order the source holds them, and their index;
 * every rows of the type without one. Views resolve a selection once, here, and test rows against it.
 */
export async function readRows(
  reader: ReadScope,
  source: Data,
  from: string,
  rows?: RowSelection,
): Promise<{ readonly index?: Index; readonly rows: Uint32Array }> {
  let index: Index | undefined,
    out = new Uint32Array(64),
    length = 0;
  for await (const block of reader.read(source, {
    kind: 'rows',
    from,
    select: [],
    ...(rows ? { rows } : {}),
  })) {
    if (index) assertIndex(index, block.index);
    else index = block.index;
    const n = rowCount(block.rows);
    if (length + n > out.length) {
      const grown = new Uint32Array(Math.max(out.length * 2, length + n));
      grown.set(out.subarray(0, length));
      out = grown;
    }
    if (block.rows.kind === 'range')
      for (let i = 0; i < n; i++) out[length + i] = block.rows.offset + i;
    else out.set(block.rows.values, length);
    length += n;
  }
  return { index, rows: out.slice(0, length) };
}

/** One end of an edge: the edge type's reference field and the vertex type it names. */
export interface End {
  readonly field: string;
  readonly type: string;
}
/** A vertex type's reference field naming a net, which draws as a port. */
export interface Port {
  readonly type: string;
  readonly field: string;
  readonly direction?: 'in' | 'out';
}
/** How one drawn edge type joins drawn vertex types: its own two ends, or the ports naming it. */
export type Wiring =
  | { readonly kind: 'ends'; readonly ends: readonly [End, End] }
  | { readonly kind: 'net'; readonly ports: readonly Port[] };

/** How each drawn edge type joins drawn vertex types. Schema only; each view does its own reads. */
export function wiring(
  schema: Schema,
  vertices: readonly string[],
  edges: Readonly<Record<string, { readonly ends?: readonly [string, string] }>>,
): ReadonlyMap<string, Wiring> {
  const drawn = new Set(vertices);
  const target = (type: string, field: string) => {
    const t = schema.types[type]?.fields[field]?.type;
    return typeof t === 'object' && t.kind === 'reference' ? t.to : undefined;
  };
  const result = new Map<string, Wiring>();
  for (const [edge, { ends }] of Object.entries(edges)) {
    if (!schema.types[edge]) throw failure('invalid-input', 'Unknown edge type: ' + edge);
    if (ends) {
      const [a, b] = ends.map((field): End => {
        const type = target(edge, field);
        if (type === undefined || !drawn.has(type))
          throw failure('invalid-input', `Edge end ${edge}.${field} must reference a vertex type`);
        return { field, type };
      });
      result.set(edge, { kind: 'ends', ends: [a, b] });
      continue;
    }
    const ports = vertices.flatMap((type) =>
      Object.entries(schema.types[type]?.fields ?? {})
        .filter(([field]) => target(type, field) === edge)
        .map(([field, definition]): Port => ({
          type,
          field,
          ...(definition.direction ? { direction: definition.direction } : {}),
        })),
    );
    if (!ports.length) throw failure('invalid-input', 'No vertex type references net ' + edge);
    result.set(edge, { kind: 'net', ports });
  }
  return result;
}
