import type { Schema } from '@latkit/model';
import { GpuError } from '../error.js';

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
    if (!schema.types[edge]) throw new GpuError('invalid-input', 'Unknown edge type: ' + edge);
    if (ends) {
      const [a, b] = ends.map((field): End => {
        const type = target(edge, field);
        if (type === undefined || !drawn.has(type))
          throw new GpuError(
            'invalid-input',
            `Edge end ${edge}.${field} must reference a vertex type`,
          );
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
    if (!ports.length) throw new GpuError('invalid-input', 'No vertex type references net ' + edge);
    result.set(edge, { kind: 'net', ports });
  }
  return result;
}
